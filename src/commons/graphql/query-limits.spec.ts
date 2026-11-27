import { GraphQLRequestContextDidResolveOperation, GraphQLRequestListener } from '@apollo/server';
import { buildSchema, getIntrospectionQuery, GraphQLError, OperationDefinitionNode, parse, validate } from 'graphql';
import { getComplexity } from 'graphql-query-complexity';
import { aliasLimitRule, depthLimitRule, listAwareEstimator, queryCostPlugin } from './query-limits';

const schema = buildSchema(`
  input PaginationArgs { first: Int }
  type Profile { displayName: String! }
  type Review { score: Int! user: Profile! product: Product! }
  type Variant { id: ID! size: String }
  type Product { id: ID! name: String! reviews: [Review!] variants: [Variant!] }
  type ProductEdge { node: Product! }
  type ProductConnection { edges: [ProductEdge!]! }
  type Category { name: String! products(first: Int): [Product!]! }
  type Tier { minQuantity: Int! }
  type Entry { id: ID! tiers: [Tier!]! }
  type EntryPage { nodes: [Entry!]! totalCount: Int! }
  type Query {
    entries(first: Int): EntryPage!
    products(paginationArgs: PaginationArgs): ProductConnection!
    product(id: ID!): Product
    categories: [Category!]!
  }
`);

const errorsFor = (query: string, rule: ReturnType<typeof depthLimitRule>) =>
  validate(schema, parse(query), [rule]).map((e) => e.message);

const cost = (query: string, variables: Record<string, unknown> = {}) =>
  getComplexity({ schema, query: parse(query), variables, estimators: [listAwareEstimator] });

describe('depthLimitRule', () => {
  it('accepts the deepest query the storefront uses', () => {
    const query = '{ products { edges { node { reviews { user { displayName } } } } } }';

    expect(errorsFor(query, depthLimitRule(8))).toEqual([]);
  });

  it('rejects a query that walks the review/product cycle too deep', () => {
    const query =
      '{ product(id: "1") { reviews { product { reviews { product { reviews { product { reviews { score } } } } } } } } }';

    expect(errorsFor(query, depthLimitRule(8))).toEqual(['Query depth 9 exceeds the maximum of 8']);
  });

  it('counts depth through fragments and survives fragment cycles', () => {
    const query = `
      { product(id: "1") { ...R } }
      fragment R on Product { reviews { product { ...R } } }
    `;

    expect(errorsFor(query, depthLimitRule(2))).toEqual(['Query depth 3 exceeds the maximum of 2']);
  });

  it('ignores introspection so dev tooling keeps working', () => {
    expect(errorsFor(getIntrospectionQuery(), depthLimitRule(8))).toEqual([]);
  });
});

describe('aliasLimitRule', () => {
  const aliased = (count: number) =>
    `{ ${Array.from({ length: count }, (_, i) => `a${i}: product(id: "${i}") { id }`).join(' ')} }`;

  it('accepts up to the limit', () => {
    expect(errorsFor(aliased(15), aliasLimitRule(15))).toEqual([]);
  });

  it('rejects alias batching above the limit', () => {
    expect(errorsFor(aliased(16), aliasLimitRule(15))).toEqual(['Query uses 16 aliases; the maximum is 15']);
  });
});

describe('listAwareEstimator', () => {
  it('multiplies a connection by the requested page size, counting edges once', () => {
    // products 1 + 20 × (edges 1 + node 1 + name 1)
    expect(cost('{ products(paginationArgs: { first: 20 }) { edges { node { name } } } }')).toBe(61);
  });

  it('multiplies a page by the requested page size, counting its nodes once', () => {
    // entries 1 + 50 × (nodes 1 + (id 1 + tiers 1 + 10 × minQuantity 1) + totalCount 1)
    expect(cost('{ entries(first: 50) { totalCount nodes { id tiers { minQuantity } } } }')).toBe(701);
  });

  it('uses the request variables for the page size', () => {
    const query = 'query($n: Int) { products(paginationArgs: { first: $n }) { edges { node { name } } } }';

    expect(cost(query, { n: 50 })).toBe(151);
  });

  it('assumes the default list size when no page size is given', () => {
    // categories 1 + 10 × (name 1 + products 1 + 10 × name 1)
    expect(cost('{ categories { name products { name } } }')).toBe(121);
  });

  it('keeps a realistic catalogue page within budget', () => {
    const query = `{ products(paginationArgs: { first: 50 }) { edges { node {
      id name variants { id size } reviews { score user { displayName } } } } } }`;

    expect(cost(query)).toBeLessThanOrEqual(3000);
  });

  it('prices an abusive nested fan-out far above budget', () => {
    const query = `{ products(paginationArgs: { first: 100 }) { edges { node {
      reviews { product { reviews { product { reviews { score } } } } } } } } }`;

    expect(cost(query)).toBeGreaterThan(3000);
  });

  it('does not charge for introspection', () => {
    expect(cost('{ __schema { types { name fields { name } } } }')).toBe(0);
  });
});

describe('queryCostPlugin', () => {
  const resolveOperation = async (query: string, variables?: Record<string, unknown>, maxCost = 3000) => {
    const listener = (await queryCostPlugin(maxCost).requestDidStart!({} as never)) as GraphQLRequestListener<
      Record<string, never>
    >;
    const document = parse(query);
    const context = {
      request: { query, variables },
      document,
      schema,
      operation: document.definitions[0] as OperationDefinitionNode,
    } as unknown as GraphQLRequestContextDidResolveOperation<Record<string, never>>;
    return listener.didResolveOperation!(context);
  };

  const pageQuery = 'query($n: Int!) { products(paginationArgs: { first: $n }) { edges { node { name } } } }';

  it('lets a query within budget through', async () => {
    await expect(resolveOperation(pageQuery, { n: 20 })).resolves.toBeUndefined();
  });

  it('refuses a query over budget as a validation failure', async () => {
    const refusal = resolveOperation(pageQuery, { n: 100 }, 100);

    await expect(refusal).rejects.toThrow(GraphQLError);
    await expect(refusal).rejects.toMatchObject({
      message: 'Query cost 301 exceeds the maximum of 100',
      extensions: { code: 'GRAPHQL_VALIDATION_FAILED', http: { status: 400 } },
    });
  });

  // Execution reports variables that do not coerce as BAD_USER_INPUT; the estimate must not throw first.
  it('leaves a missing required variable to execution', async () => {
    await expect(resolveOperation(pageQuery, {})).resolves.toBeUndefined();
    await expect(resolveOperation(pageQuery)).resolves.toBeUndefined();
  });

  it('leaves a wrongly typed variable to execution', async () => {
    await expect(resolveOperation(pageQuery, { n: 'many' })).resolves.toBeUndefined();
  });
});
