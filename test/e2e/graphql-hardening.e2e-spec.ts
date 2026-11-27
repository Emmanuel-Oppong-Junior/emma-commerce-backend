import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

describe('GraphQL hardening (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const codeOf = (res: { body: { errors?: { extensions?: { code?: string } }[] } }) =>
    res.body.errors?.[0]?.extensions?.code;

  describe('error codes', () => {
    it('returns CONFLICT, not a server error, when a delete violates a foreign key', async () => {
      await prisma.category.create({ data: { id: 'cat_with_sub', name: 'Audio' } });
      await prisma.subCategory.create({ data: { name: 'Headphones', categoryId: 'cat_with_sub' } });

      const res = await gqlRequest(
        app,
        'mutation { removeCategory(id: "cat_with_sub") { id } }',
        undefined,
        adminToken,
      ).expect(200);

      expect(codeOf(res)).toBe('CONFLICT');
      expect(res.body.errors[0].message).toBe(
        'This record is referenced by other records and cannot be changed or removed',
      );
      expect(JSON.stringify(res.body)).not.toMatch(/prisma|fkey/i);
    });

    it('returns UNAUTHENTICATED for a protected query without a token', async () => {
      const res = await gqlRequest(app, '{ adminProducts { edges { node { id } } } }').expect(200);

      expect(codeOf(res)).toBe('UNAUTHENTICATED');
    });

    it('returns NOT_FOUND for a missing record', async () => {
      const res = await gqlRequest(
        app,
        'mutation { removeCategory(id: "does-not-exist") { id } }',
        undefined,
        adminToken,
      ).expect(200);

      expect(codeOf(res)).toBe('NOT_FOUND');
    });

    it('returns BAD_USER_INPUT for input that fails validation', async () => {
      const res = await gqlRequest(
        app,
        'mutation { signUp(input: { name: "A", email: "not-an-email", password: "x" }) { accessToken } }',
      ).expect(200);

      expect(codeOf(res)).toBe('BAD_USER_INPUT');
    });
  });

  describe('variables', () => {
    const flaggedOrders = 'query ($first: Int!) { flaggedOrders(first: $first) { id } }';

    it('answers a missing required variable with 400 BAD_USER_INPUT', async () => {
      const res = await gqlRequest(app, flaggedOrders, {}, adminToken).expect(400);

      expect(codeOf(res)).toBe('BAD_USER_INPUT');
      expect(res.body.errors[0].message).toMatch(/\$first/);
    });

    it('answers a wrongly typed variable with 400 BAD_USER_INPUT', async () => {
      const res = await gqlRequest(app, flaggedOrders, { first: 'ten' }, adminToken).expect(400);

      expect(codeOf(res)).toBe('BAD_USER_INPUT');
      expect(res.body.errors[0].message).toMatch(/\$first/);
    });
  });

  describe('query limits', () => {
    it('still serves a normal catalogue page', async () => {
      const res = await gqlRequest(
        app,
        `{ products(paginationArgs: { first: 50 }) { edges { node {
          id name variants { id } reviews { score user { displayName } } } } } }`,
      ).expect(200);

      expect(res.body.errors).toBeUndefined();
    });

    it('rejects a query deeper than 8 levels', async () => {
      const res = await gqlRequest(
        app,
        `{ product(productId: "seed_prod1") { reviews { product { reviews { product {
          reviews { product { reviews { score } } } } } } } } }`,
      ).expect(400);

      expect(codeOf(res)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(res.body.errors[0].message).toMatch(/Query depth 9 exceeds the maximum of 8/);
    });

    it('rejects alias batching above 15 aliases', async () => {
      const fields = Array.from({ length: 16 }, (_, i) => `a${i}: product(productId: "seed_prod1") { id }`).join(' ');
      const res = await gqlRequest(app, `{ ${fields} }`).expect(400);

      expect(res.body.errors[0].message).toMatch(/16 aliases; the maximum is 15/);
    });

    it('rejects a shallow query whose estimated cost is over budget', async () => {
      const res = await gqlRequest(
        app,
        `{ products(paginationArgs: { first: 100 }) { edges { node {
          reviews { product { reviews { score } } } } } } }`,
      ).expect(400);

      expect(codeOf(res)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(res.body.errors[0].message).toMatch(/Query cost \d+ exceeds the maximum of 3000/);
    });
  });
});
