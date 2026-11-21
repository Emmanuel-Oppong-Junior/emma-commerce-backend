import { ApolloServerPlugin } from '@apollo/server';
import {
  ASTVisitor,
  FieldNode,
  FragmentDefinitionNode,
  getNamedType,
  GraphQLError,
  isListType,
  isNonNullType,
  Kind,
  SelectionSetNode,
  ValidationContext,
} from 'graphql';
import { ComplexityEstimatorArgs, getComplexity } from 'graphql-query-complexity';

export const MAX_QUERY_DEPTH = 8;
export const MAX_ALIASES = 15;
export const MAX_QUERY_COST = 3000;
export const DEFAULT_LIST_SIZE = 10;

const isIntrospection = (name: string) => name.startsWith('__');

function selectionDepth(
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
  visited: Set<string>,
): number {
  if (!selectionSet) return 0;
  let deepest = 0;
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (isIntrospection(selection.name.value)) continue;
      deepest = Math.max(deepest, 1 + selectionDepth(selection.selectionSet, fragments, visited));
    } else if (selection.kind === Kind.INLINE_FRAGMENT) {
      deepest = Math.max(deepest, selectionDepth(selection.selectionSet, fragments, visited));
    } else {
      const name = selection.name.value;
      if (visited.has(name) || !fragments[name]) continue;
      deepest = Math.max(deepest, selectionDepth(fragments[name].selectionSet, fragments, new Set([...visited, name])));
    }
  }
  return deepest;
}

export function depthLimitRule(maxDepth = MAX_QUERY_DEPTH) {
  return (context: ValidationContext): ASTVisitor => {
    const fragments = Object.fromEntries(
      context
        .getDocument()
        .definitions.filter((d): d is FragmentDefinitionNode => d.kind === Kind.FRAGMENT_DEFINITION)
        .map((d) => [d.name.value, d]),
    );
    return {
      OperationDefinition(operation) {
        const depth = selectionDepth(operation.selectionSet, fragments, new Set());
        if (depth > maxDepth) {
          context.reportError(new GraphQLError(`Query depth ${depth} exceeds the maximum of ${maxDepth}`, [operation]));
        }
      },
    };
  };
}

export function aliasLimitRule(maxAliases = MAX_ALIASES) {
  return (context: ValidationContext): ASTVisitor => {
    let aliases = 0;
    return {
      Field(node: FieldNode) {
        if (node.alias) aliases += 1;
      },
      Document: {
        leave(document) {
          if (aliases > maxAliases) {
            context.reportError(
              new GraphQLError(`Query uses ${aliases} aliases; the maximum is ${maxAliases}`, [document]),
            );
          }
        },
      },
    };
  };
}

// Lists cost their child complexity times the page size the client asked for (or a default).
// Connection `edges` and page `nodes` are already multiplied at the connection or page field, so they count once.
export function listAwareEstimator({ type, field, args, childComplexity }: ComplexityEstimatorArgs): number {
  if (isIntrospection(type.name) || isIntrospection(field.name)) return 0;
  const requested = args.first ?? args.paginationArgs?.first;
  const returnType = isNonNullType(field.type) ? field.type.ofType : field.type;
  const isPageItems =
    (type.name.endsWith('Connection') && field.name === 'edges') ||
    (type.name.endsWith('Page') && field.name === 'nodes');
  const pageType = getNamedType(field.type).name;
  const isPage = pageType.endsWith('Connection') || pageType.endsWith('Page');
  let size = 1;
  if (typeof requested === 'number') size = requested;
  else if (isPage || (isListType(returnType) && !isPageItems)) size = DEFAULT_LIST_SIZE;
  return 1 + size * childComplexity;
}

export function queryCostPlugin(maxCost = MAX_QUERY_COST): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document, schema }) {
          const cost = getComplexity({
            schema,
            query: document,
            operationName: request.operationName ?? undefined,
            variables: request.variables ?? {},
            estimators: [listAwareEstimator],
          });
          if (cost > maxCost) {
            throw new GraphQLError(`Query cost ${cost} exceeds the maximum of ${maxCost}`, {
              extensions: { code: 'GRAPHQL_VALIDATION_FAILED', http: { status: 400 } },
            });
          }
        },
      };
    },
  };
}
