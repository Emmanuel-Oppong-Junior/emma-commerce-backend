import { ApolloServer, HeaderMap } from '@apollo/server';
import { CACHE_TAG_HEADER, SURROGATE_KEY_HEADER, httpCachePlugins } from './http-cache.plugin';

const typeDefs = `#graphql
  type Query {
    product(id: ID!): Product
    products: [Product!]!
    cart: Cart
  }
  type Mutation { touch: Boolean }
  type Product { id: ID! name: String! variants: [Variant!]! reviews: [Review!]! brand: Brand }
  type Variant { id: ID! sku: String customerPrice: Money }
  type Money { amount: String! }
  type Review { id: ID! body: String! }
  type Brand { id: ID! name: String! }
  type Cart { id: ID! }
`;

const product = (id: string) => ({
  id,
  name: `Product ${id}`,
  variants: [{ id: `${id}-v`, sku: 'SKU', customerPrice: { amount: '1.00' } }],
  reviews: [],
  brand: { id: 'b1', name: 'Brand' },
});

const resolvers = {
  Query: {
    product: (_: unknown, { id }: { id: string }) => (id === 'missing' ? null : product(id)),
    products: () => [product('p1'), product('p2')],
    cart: () => ({ id: 'cart' }),
  },
  Mutation: { touch: () => true },
};

describe('httpCachePlugins', () => {
  let server: ApolloServer<{ res?: { vary: jest.Mock } }>;

  beforeAll(async () => {
    server = new ApolloServer({ typeDefs, resolvers, plugins: httpCachePlugins() });
    await server.start();
  });

  afterAll(() => server.stop());

  async function run(
    query: string,
    { method = 'GET', authorization }: { method?: string; authorization?: string } = {},
  ) {
    const headers = new HeaderMap();
    if (authorization) headers.set('authorization', authorization);
    const res = { vary: jest.fn() };
    const response = await server.executeOperation(
      { query, http: { method, headers, search: '', body: {} } },
      { contextValue: { res } },
    );
    return { headers: response.http.headers, vary: res.vary };
  }

  it('caches an anonymous GET of public fields publicly, tagged with what it shows', async () => {
    const { headers, vary } = await run('{ products { id name variants { sku } brand { name } } }');

    expect(headers.get('cache-control')).toBe('public, max-age=60, stale-while-revalidate=30');
    expect(headers.get(SURROGATE_KEY_HEADER)).toBe('catalogue brand:b1 product:p1 product:p2 products');
    expect(headers.get(CACHE_TAG_HEADER)).toBe('catalogue,brand:b1,product:p1,product:p2,products');
    expect(vary).toHaveBeenCalledWith('Authorization');
  });

  it('tags a detail query with its entity only, and a missing one with the family key', async () => {
    expect((await run('{ product(id: "p9") { name } }')).headers.get(SURROGATE_KEY_HEADER)).toBe(
      'catalogue product:p9',
    );
    expect((await run('{ product(id: "missing") { name } }')).headers.get(SURROGATE_KEY_HEADER)).toBe(
      'catalogue products',
    );
  });

  it.each([
    ['a POST', '{ products { id } }', { method: 'POST' }],
    ['a request with a bearer token', '{ products { id } }', { authorization: 'Bearer token' }],
    ['a customer-price field', '{ products { variants { customerPrice { amount } } } }', {}],
    ['a type that is not public', '{ products { reviews { body } } }', {}],
    ['a root query that is not public', '{ cart { id } }', {}],
  ])('answers %s with private, no-store and no surrogate keys', async (_case, query, options) => {
    const { headers, vary } = await run(query, options);

    expect(headers.get('cache-control')).toBe('private, no-store');
    expect(headers.get(SURROGATE_KEY_HEADER)).toBeUndefined();
    expect(vary).not.toHaveBeenCalled();
  });

  it('never caches a mutation', async () => {
    expect((await run('mutation { touch }', { method: 'POST' })).headers.get('cache-control')).toBe(
      'private, no-store',
    );
  });

  it('never caches a response with errors', async () => {
    expect((await run('{ product { id } }')).headers.get('cache-control')).toBe('private, no-store');
  });
});
