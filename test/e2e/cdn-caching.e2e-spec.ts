import { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { APQ_KEY_PREFIX } from '../../src/cdn/apq-cache';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, SeedResult } from '../helpers/db.helper';
import { signInUser } from '../helpers/auth.helper';

// HTTP caching of the anonymous catalogue (P9-C): APQ over GET, public Cache-Control and surrogate keys only for an
// anonymous GET whose every field is public, private, no-store for everything else.

const PUBLIC_CACHE = 'public, max-age=60, stale-while-revalidate=30';
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('CDN-ready caching of the anonymous catalogue (P9-C, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let seed: SeedResult;
  let userToken: string;

  /** A GET the way Apollo Client sends one: params in the URL and a preflight header for Apollo's CSRF check. */
  const getGraphql = (params: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const query = Object.fromEntries(
      Object.entries(params).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
    );
    return request(app.getHttpServer())
      .get('/graphql')
      .query(query)
      .set({ 'apollo-require-preflight': 'true', ...headers });
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    redis = app.get<Redis>(REDIS_CLIENT);
    await resetDb(prisma);
    seed = await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('automatic persisted queries', () => {
    const query = 'query Catalogue { products(paginationArgs: { first: 5 }) { edges { node { id name } } } }';
    const hash = sha256(query);
    const persisted = { persistedQuery: { version: 1, sha256Hash: hash } };

    it('asks for the query when a hash is unknown', async () => {
      const res = await getGraphql({ extensions: persisted }).expect(200);
      expect(res.body.errors[0].extensions.code).toBe('PERSISTED_QUERY_NOT_FOUND');
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('registers a query in Redis, then answers the hash alone over GET with a cacheable response', async () => {
      const registered = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query, extensions: persisted })
        .expect(200);
      expect(registered.body.errors).toBeUndefined();
      await expect(redis.ttl(`${APQ_KEY_PREFIX}apq:${hash}`)).resolves.toBeGreaterThan(0);

      const res = await getGraphql({ operationName: 'Catalogue', extensions: persisted }).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.products.edges.map((edge: { node: { id: string } }) => edge.node.id)).toEqual(
        expect.arrayContaining([seed.productIds.prod1, seed.productIds.prod2]),
      );
      expect(res.headers['cache-control']).toBe(PUBLIC_CACHE);
      expect(res.headers['surrogate-key'].split(' ')).toEqual(
        expect.arrayContaining(['catalogue', 'products', `product:${seed.productIds.prod1}`]),
      );
    });

    it('refuses a hash that does not match the query sent with it', async () => {
      const res = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query, extensions: { persistedQuery: { version: 1, sha256Hash: sha256('something else') } } })
        .expect(400);
      expect(res.body.errors[0].message).toBe('provided sha does not match query');
    });
  });

  describe('GET', () => {
    it('refuses a mutation', async () => {
      const res = await getGraphql({ query: 'mutation { signOut(input: { refreshToken: "x" }) }' }).expect(405);
      expect(res.headers['cache-control']).not.toMatch(/public/);
    });

    it("keeps Apollo's CSRF check: a GET without a preflight header is refused", async () => {
      await request(app.getHttpServer()).get('/graphql').query({ query: '{ brands { id } }' }).expect(400);
    });

    it('still enforces the query depth limit', async () => {
      const deep = `{ products { edges { node { category { subcategories { category { products { brand { products {
        id } } } } } } } } } }`;
      const res = await getGraphql({ query: deep });
      expect(res.body.errors[0].message).toMatch(/depth/);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('still enforces the query cost limit', async () => {
      const costly = `{ products(paginationArgs: { first: 100 }) { edges { node { variants { id } tags { id }
        category { products(first: 100) { id } } } } } }`;
      const res = await getGraphql({ query: costly });
      expect(res.body.errors[0].message).toMatch(/cost/);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });
  });

  describe('Cache-Control and surrogate keys', () => {
    const productQuery = (id: string) =>
      `{ product(productId: "${id}") { id name inStock variants { sku available price { amount } } brand { name } category { name } } }`;

    it('makes an anonymous GET of a public product public, tagged with what it shows', async () => {
      const res = await getGraphql({ query: productQuery(seed.productIds.prod1) }).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.headers['cache-control']).toBe(PUBLIC_CACHE);
      expect(res.headers['surrogate-key'].split(' ')).toEqual([
        'catalogue',
        `brand:${seed.brandId}`,
        `category:${seed.categoryId}`,
        `product:${seed.productIds.prod1}`,
      ]);
      expect(res.headers['cache-tag']).toBe(res.headers['surrogate-key'].split(' ').join(','));
      expect(res.headers.vary).toMatch(/Authorization/);
    });

    it('tags a product that does not exist with the products family, so creating it purges the cached null', async () => {
      const res = await getGraphql({ query: productQuery('no_such_product') }).expect(200);
      expect(res.body.data.product).toBeNull();
      expect(res.headers['surrogate-key']).toBe('catalogue products');
    });

    it('tags lists, categories, brands and the homepage', async () => {
      const res = await getGraphql({ query: '{ categories { id } brands { id } homepage { id } }' }).expect(200);
      expect(res.headers['cache-control']).toBe(PUBLIC_CACHE);
      expect(res.headers['surrogate-key'].split(' ')).toEqual(
        expect.arrayContaining(['catalogue', 'brands', 'categories', 'homepage', `category:${seed.categoryId}`]),
      );
    });

    it('never caches the same query publicly when it carries a bearer token', async () => {
      const res = await getGraphql(
        { query: productQuery(seed.productIds.prod1) },
        { Authorization: `Bearer ${userToken}` },
      ).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['surrogate-key']).toBeUndefined();
      expect(res.headers['cache-tag']).toBeUndefined();
    });

    it('never caches a response with a customer-price field publicly, even for a visitor', async () => {
      const res = await getGraphql({
        query: `{ product(productId: "${seed.productIds.prod1}") { variants { customerPrice { unitPrice { amount } } priceTiers { minQuantity } } } }`,
      }).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['surrogate-key']).toBeUndefined();
    });

    it('never caches a response that selects a non-catalogue type (reviews)', async () => {
      const res = await getGraphql({
        query: `{ product(productId: "${seed.productIds.prod1}") { reviews { id } } }`,
      }).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it('never caches a POST, even for a visitor', async () => {
      const res = await gqlRequest(app, productQuery(seed.productIds.prod1)).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.headers['surrogate-key']).toBeUndefined();
    });

    it('never caches a query outside the public catalogue', async () => {
      const res = await getGraphql({ query: '{ myPhoneVerification { phoneVerified } }' }).expect(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });
  });
});
