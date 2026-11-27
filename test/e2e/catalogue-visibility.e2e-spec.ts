import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, SeedResult, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

const HIDDEN_NAMES = ['Unreleased Tablet', 'Discontinued Watch'];

describe('Catalogue visibility (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let seed: SeedResult;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    seed = await seedMinimal(prisma);
    await prisma.subCategory.create({ data: { id: 'seed_sub', name: 'Laptops', categoryId: seed.categoryId } });
    await prisma.product.updateMany({ data: { subcategoryId: 'seed_sub' } });
    adminToken = await signInAdmin(app);
    userToken = await signInUser(app);
  });

  afterAll(async () => {
    await app.close();
  });

  const expectOnlyPublished = (body: unknown) => {
    const text = JSON.stringify(body);
    HIDDEN_NAMES.forEach((name) => expect(text).not.toContain(name));
    expect(text).toContain('Laptop');
  };

  it('hides drafts and inactive products from the public products list, whatever filter is sent', async () => {
    const res = await gqlRequest(
      app,
      `{ products(paginationArgs: { first: 50 }, filterArgs: { isActive: false, status: DRAFT }) { edges { node { name } } } }`,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    const names = res.body.data.products.edges.map((e: { node: { name: string } }) => e.node.name).sort();
    expect(names).toEqual(['Laptop', 'Phone']);
  });

  it.each([
    ['draft', 'seed_prod_draft'],
    ['inactive', 'seed_prod_inactive'],
  ])('returns null for a %s product by id', async (_kind, id) => {
    const res = await gqlRequest(app, `{ product(productId: "${id}") { id name } }`).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.product).toBeNull();
  });

  it.each([
    ['categories', '{ categories { name products { name } } }'],
    ['brands', '{ brands { name products { name } } }'],
    ['brand', '{ brand(id: "seed_brand") { name products { name } } }'],
    ['product.category', '{ product(productId: "seed_prod1") { category { products { name } } } }'],
  ])('only nests published products under %s', async (_path, query) => {
    const res = await gqlRequest(app, query).expect(200);

    expect(res.body.errors).toBeUndefined();
    expectOnlyPublished(res.body);
  });

  it('only nests published products under subCategories for a logged-in customer', async () => {
    const res = await gqlRequest(app, '{ subCategories { name products { name } } }', undefined, userToken).expect(200);

    expect(res.body.errors).toBeUndefined();
    expectOnlyPublished(res.body);
  });

  it('resolves SubCategory.category as a Category, with its own subcategories', async () => {
    const res = await gqlRequest(
      app,
      '{ subCategories { name category { __typename name subcategories { name } } } }',
      undefined,
      userToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.subCategories[0]).toEqual({
      name: 'Laptops',
      category: { __typename: 'Category', name: 'Electronics', subcategories: [{ name: 'Laptops' }] },
    });
  });

  it('caps nested products with first', async () => {
    const res = await gqlRequest(app, '{ categories { products(first: 1) { name } } }').expect(200);

    expect(res.body.data.categories[0].products).toHaveLength(1);
  });

  it('rejects first above 100', async () => {
    const res = await gqlRequest(app, '{ categories { products(first: 101) { name } } }').expect(200);

    expect(res.body.errors?.[0]?.message).toMatch(/first must be an integer from 1 to 100/);
  });

  it('shows admins every product through adminProducts', async () => {
    const res = await gqlRequest(
      app,
      '{ adminProducts(paginationArgs: { first: 50 }) { edges { node { name status isActive } } } }',
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    const names = res.body.data.adminProducts.edges.map((e: { node: { name: string } }) => e.node.name).sort();
    expect(names).toEqual(['Discontinued Watch', 'Laptop', 'Phone', 'Unreleased Tablet']);
  });

  it.each([
    ['isActive: null', ['Discontinued Watch', 'Laptop', 'Phone', 'Unreleased Tablet']],
    ['search: null', ['Discontinued Watch', 'Laptop', 'Phone', 'Unreleased Tablet']],
    ['isActive: true', ['Laptop', 'Phone', 'Unreleased Tablet']],
    ['isActive: false', ['Discontinued Watch']],
  ])('adminProducts with filterArgs { %s } returns %j', async (filter, expected) => {
    const res = await gqlRequest(
      app,
      `{ adminProducts(paginationArgs: { first: 50 }, filterArgs: { ${filter} }) { edges { node { name } } } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    const names = res.body.data.adminProducts.edges.map((e: { node: { name: string } }) => e.node.name).sort();
    expect(names).toEqual(expected);
  });

  it('returns a draft to admins through adminProduct', async () => {
    const res = await gqlRequest(
      app,
      `{ adminProduct(productId: "${seed.productIds.draft}") { name status } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.data.adminProduct).toEqual({ name: 'Unreleased Tablet', status: 'DRAFT' });
  });

  it('refuses adminProducts to a customer', async () => {
    const res = await gqlRequest(app, '{ adminProducts { edges { node { id } } } }', undefined, userToken).expect(200);

    expect(res.body.errors).toBeDefined();
    expect(res.body.data).toBeNull();
  });
});
