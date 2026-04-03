import { GraphQLResolveInfo } from 'graphql/type';
import { FieldNode } from 'graphql/language';
import { parseResolveInfo, ResolveTree } from 'graphql-parse-resolve-info';
import { Prisma } from '@prisma/client';

/**
 * Converts the GraphQL resolve info into a Prisma `select` object.
 * Uses graphql-parse-resolve-info for reliable field extraction (handles aliases,
 * fragments, and nested selection sets correctly).
 *
 * @param info - The GraphQL resolve info object.
 * @param excludedFields - Field names to exclude from the select (e.g. computed fields).
 * @returns A Prisma-compatible select object, or an empty object if parsing fails.
 */
export const extractFieldsFromInfo = (
  info: GraphQLResolveInfo,
  excludedFields: string[] = [],
): Prisma.ProductSelect => {
  try {
    const parsed = parseResolveInfo(info) as ResolveTree;
    if (!parsed) return {};
    const buildSelect = (fields: Record<string, ResolveTree>): Record<string, any> => {
      const select: Record<string, any> = {};
      for (const [alias, field] of Object.entries(fields)) {
        const name = field.name;
        if (excludedFields.includes(name) || name === '__typename') continue;
        const nestedFields = Object.values(field.fieldsByTypeName)[0];
        if (nestedFields && Object.keys(nestedFields).length > 0) {
          select[name] = { select: buildSelect(nestedFields) };
        } else {
          select[name] = true;
        }
        // suppress unused alias warning
        void alias;
      }
      return select;
    };

    const topLevelFields = Object.values(parsed.fieldsByTypeName)[0];
    return topLevelFields ? buildSelect(topLevelFields) : {};
  } catch {
    return {};
  }
};

export function sanitizeVariables(
  variables: Record<string, any>,
  fieldsToMask = ['password', 'confirmPassword'],
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const key in variables) {
    if (fieldsToMask.includes(key)) {
      result[key] = '****';
    } else if (typeof variables[key] === 'object' && variables[key] !== null) {
      result[key] = sanitizeVariables(variables[key], fieldsToMask);
    } else {
      result[key] = variables[key];
    }
  }
  return result;
}

export function sanitizeQuery(query: string, fieldsToMask = ['password', 'confirmPassword', 'newPassword']): string {
  const pattern = new RegExp(`(${fieldsToMask.join('|')})\\s*:\\s*"(.*?)"`, 'gi');
  return query.replace(pattern, (_, key) => `${key}: "****"`);
}

/**
 * returns today's date
 * eg: 2025-04-19
 */
export const getTodayDate = () => {
  return new Date().toISOString().split('T')[0];
};

/**
 * Extracts all fields, including inner fields, from the given GraphQL info object.
 * @param {object} info - The GraphQL info object containing the field nodes.
 * @param options
 * @returns {object} An object with the extracted fields as keys and true as values.
 */
export const extractRequestedFieldsFromQuery = (
  info: GraphQLResolveInfo,
  options: { excludedFields?: string[]; level?: 1 | 2 | 3 } = { excludedFields: [], level: 1 },
): object => {
  if (!info) return {};
  const prismaSelect: Record<string, unknown> = {};
  (options.excludedFields ?? []).push('__typename');
  // if (options.level === 2) {
  //   const item = info.fieldNodes[0]?.selectionSet?.selections.find((selection) =>
  //     Array.isArray((selection as FieldNode)?.selectionSet?.selections),
  //   );
  //   parseSelectionSet((item as FieldNode).selectionSet, prismaSelect, options.excludedFields);
  // } else {
  //   parseSelectionSet(info.fieldNodes[0]?.selectionSet, prismaSelect, options.excludedFields);
  // }
  const parseSelectionSet = (
    selectionSet: { selections?: readonly unknown[] } | undefined,
    currentSelect: Record<string, unknown>,
  ) => {
    selectionSet?.selections?.forEach((selection) => {
      const sel = selection as { kind: string; name?: { value: string }; selectionSet?: { selections?: unknown[] } };
      if (sel.kind === 'Field') {
        // Check if the field should be excluded
        if (!(options.excludedFields ?? []).includes(sel?.name?.value ?? '')) {
          if (sel.selectionSet) {
            // Include at least the id to prevent an error if the excluded field was the only child
            currentSelect[sel.name!.value] = { id: true };
            parseSelectionSet(sel.selectionSet, currentSelect[sel.name!.value] as Record<string, unknown>);
          } else {
            currentSelect[sel.name!.value] = true;
          }
        }
      }
    });
  };
  if (options.level === 3) {
    const firstLayer = info.fieldNodes[0]?.selectionSet?.selections.find((selection) =>
      Array.isArray((selection as FieldNode)?.selectionSet?.selections),
    ) as FieldNode | undefined;
    const secondLayer = firstLayer?.selectionSet?.selections.find((selection) =>
      Array.isArray((selection as FieldNode)?.selectionSet?.selections),
    ) as FieldNode | undefined;

    parseSelectionSet(secondLayer?.selectionSet, prismaSelect);
  } else if (options.level === 2) {
    const item = info.fieldNodes[0]?.selectionSet?.selections.find((selection) =>
      Array.isArray((selection as FieldNode)?.selectionSet?.selections),
    ) as FieldNode | undefined;

    parseSelectionSet(item?.selectionSet, prismaSelect);
  } else {
    parseSelectionSet(info.fieldNodes[0]?.selectionSet, prismaSelect);
  }
  return transformObjectToSelect(prismaSelect);
};
// const parseSelectionSet = (selectionSet: SelectionSetNode, currentSelect: object, excludedFields?: string[]) => {
//   selectionSet?.selections?.forEach((selection) => {
//     if (selection.kind === 'Field') {
//       // Check if the field should be excluded
//       if (!excludedFields?.includes(selection?.name?.value)) {
//         if (selection.selectionSet) {
//           // Include at least the id to prevent an error if the excluded field was the only child
//           currentSelect[selection.name.value] = { id: true };
//           parseSelectionSet(selection.selectionSet, currentSelect[selection.name.value]);
//         } else {
//           currentSelect[selection.name.value] = true;
//         }
//       }
//     }
//   });
// };
/**
 * Transforms an object to a Prisma select object.
 * @example
 * {id:1, user:{name:"john", age:1}} becomes {id:1, user:{select:{name:true, age:true}}}
 * @param {object} obj - The object to transform.
 * @returns {object} The transformed Prisma select object.
 */
const transformObjectToSelect = (obj: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};

  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      // If the value is an object, recursively transform it
      result[key] = { select: transformObjectToSelect(obj[key] as Record<string, unknown>) };
    } else {
      result[key] = obj[key];
    }
  }

  return result;
};
