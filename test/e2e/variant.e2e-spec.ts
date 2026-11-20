import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

const VARIANT_FIELDS =
  'id productId sku barcode optionValues quantity isActive price { amount currency } basePrice { amount }';
const CREATE_VARIANT = `mutation($input: CreateVariantInput!) { createVariant(input: $input) { ${VARIANT_FIELDS} } }`;
const UPDATE_VARIANT = `mutation($input: UpdateVariantInput!) { updateVariant(input: $input) { ${VARIANT_FIELDS} } }`;
const SHIRT = 'seed_prod2';

describe('Variants as SKUs: admin API (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let customerToken: string;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  // Variables of the wrong type fail schema validation with HTTP 400, so these helpers do not assert the status.
  const send = (query: string, token: string, variables: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token);
  const createVariant = (input: Record<string, unknown>, token = adminToken) =>
    send(CREATE_VARIANT, token, { input: { productId: SHIRT, basePrice: '120.00', quantity: 5, ...input } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.product.update({ where: { id: SHIRT }, data: { productTypeId: 'product_type_apparel' } });
    adminToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  afterEach(async () => {
    await prisma.inventoryLog.deleteMany({ where: { productId: SHIRT } });
    await prisma.variant.deleteMany({ where: { productId: SHIRT } });
  });

  afterAll(() => app.close());

  it('creates a variant with validated options, a generated SKU, its price and a logged initial stock', async () => {
    const res = await createVariant({ optionValues: { size: ' m ', colour: 'Red' }, barcode: '600123' });

    expect(res.body.errors).toBeUndefined();
    const variant = res.body.data.createVariant;
    expect(variant).toMatchObject({
      productId: SHIRT,
      optionValues: { size: 'm', colour: 'Red' },
      quantity: 5,
      isActive: true,
      barcode: '600123',
      price: ghs('120.00'),
      basePrice: { amount: '120.00' },
    });
    expect(variant.sku).toMatch(/^SKU-[0-9A-F]{12}$/);
    expect(await prisma.inventoryLog.findMany({ where: { variantId: variant.id } })).toEqual([
      expect.objectContaining({ action: 'RESTOCK', quantityChange: 5, quantityAfter: 5, reason: 'Initial stock' }),
    ]);
  });

  it('adds tax to a taxable product variant price (VAR-08)', async () => {
    await prisma.tax.create({ data: { name: 'VAT test', rate: '0.15' } });
    await prisma.product.update({ where: { id: SHIRT }, data: { isTaxable: true } });
    try {
      const res = await createVariant({ optionValues: { size: 'S' }, basePrice: '100.00' });

      expect(res.body.data.createVariant.price).toEqual(ghs('115.00'));
    } finally {
      await prisma.product.update({ where: { id: SHIRT }, data: { isTaxable: false } });
      await prisma.tax.deleteMany();
    }
  });

  it('rejects option values the product type does not define', async () => {
    const res = await createVariant({ optionValues: { flavour: 'Mint' } });

    expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(res.body.errors[0].message).toBe(
      'Invalid option values for product type "apparel": flavour is not an attribute of this product type',
    );
  });

  it('keeps option combinations unique per product, ignoring letter case and key order', async () => {
    await createVariant({ optionValues: { size: 'XL', colour: 'Blue' } });

    const duplicate = await createVariant({ optionValues: { colour: 'blue', size: 'xl' } });
    const other = await createVariant({ optionValues: { size: 'XL', colour: 'Green' } });

    expect(duplicate.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(other.body.errors).toBeUndefined();
  });

  it('refuses a fractional or oversized quantity and a malformed price as bad input (VAR-06)', async () => {
    const fractional = await send(
      `mutation { createVariant(input: { productId: "${SHIRT}", basePrice: "1.00", quantity: 1.5 }) { id } }`,
      adminToken,
      {},
    );
    const huge = await createVariant({ optionValues: { size: 'S' }, quantity: 10_000_000 });
    const price = await createVariant({ optionValues: { size: 'S' }, basePrice: '19.999' });

    expect(fractional.status).toBe(400);
    expect(fractional.body.errors[0].message).toBe('Int cannot represent non-integer value: 1.5');
    expect(huge.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(price.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(await prisma.variant.count({ where: { productId: SHIRT } })).toBe(0);
  });

  it('refuses a variant for an unknown product with NOT_FOUND', async () => {
    const res = await gql(CREATE_VARIANT, adminToken, { input: { productId: 'nope', basePrice: '1.00', quantity: 0 } });

    expect(res.body.errors[0].extensions.code).toBe('NOT_FOUND');
  });

  it('updates options and base price but never stock or the product', async () => {
    const { id } = (await createVariant({ optionValues: { size: 'M' } })).body.data.createVariant;

    const res = await gql(UPDATE_VARIANT, adminToken, {
      input: { id, optionValues: { size: 'L' }, basePrice: '99.50' },
    });
    const moved = await send(
      `mutation { updateVariant(input: { id: "${id}", productId: "seed_prod1" }) { id } }`,
      adminToken,
      {},
    );
    const restocked = await send(
      `mutation { updateVariant(input: { id: "${id}", quantity: 999 }) { id } }`,
      adminToken,
      {},
    );

    expect(res.body.data.updateVariant).toMatchObject({
      optionValues: { size: 'L' },
      price: ghs('99.50'),
      quantity: 5,
    });
    expect(moved.status).toBe(400);
    expect(moved.body.errors[0].message).toMatch(/productId/);
    expect(restocked.status).toBe(400);
    expect(restocked.body.errors[0].message).toMatch(/quantity/);
    expect(await prisma.variant.findUniqueOrThrow({ where: { id } })).toMatchObject({ productId: SHIRT, quantity: 5 });
  });

  it('refuses to delete a variant with history (CONFLICT) and lets it be archived instead (VAR-07)', async () => {
    const { id } = (await createVariant({ optionValues: { size: 'M' } })).body.data.createVariant;
    await createVariant({ optionValues: { size: 'L' }, quantity: 0 });

    const deleted = await gql(`mutation { deleteVariant(variantId: "${id}") { id } }`, adminToken);
    const archived = await gql(UPDATE_VARIANT, adminToken, { input: { id, isActive: false } });
    const recreated = await createVariant({ optionValues: { size: 'M' } });

    expect(deleted.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(deleted.body.errors[0].message).toContain('archive it (isActive: false) instead of deleting it');
    expect(archived.body.data.updateVariant.isActive).toBe(false);
    expect(recreated.body.errors).toBeUndefined();
  });

  it('deletes a variant nothing refers to', async () => {
    await createVariant({ optionValues: { size: 'M' } });
    const { id } = (await createVariant({ optionValues: { size: 'L' }, quantity: 0 })).body.data.createVariant;

    const res = await gql(`mutation { deleteVariant(variantId: "${id}") { id } }`, adminToken);

    expect(res.body.data.deleteVariant).toEqual({ id });
    const audit = await prisma.auditLog.findFirst({ where: { entity: 'Variant', entityId: id, action: 'DELETE' } });
    expect(audit).not.toBeNull();
  });

  it('lists variants to admins only, paginated and filterable by product (VAR-03, VAR-09)', async () => {
    for (const size of ['S', 'M', 'L']) await createVariant({ optionValues: { size } });

    const first = await gql(
      `{ variants(productId: "${SHIRT}", paginationArgs: { first: 2 }) { edges { cursor node { id } } pageInfo { hasNextPage totalCount } } }`,
      adminToken,
    );
    const after = first.body.data.variants.edges[1].cursor;
    const second = await gql(
      `{ variants(productId: "${SHIRT}", paginationArgs: { first: 2, after: "${after}" }) { edges { node { id } } pageInfo { hasNextPage } } }`,
      adminToken,
    );
    const customerList = await gql('{ variants { edges { node { id } } } }', customerToken);
    const customerOne = await gql(`{ variant(variantId: "${after}") { id } }`, customerToken);

    expect(first.body.data.variants.pageInfo).toEqual({ hasNextPage: true, totalCount: 3 });
    expect(second.body.data.variants).toMatchObject({ edges: [expect.anything()], pageInfo: { hasNextPage: false } });
    expect(customerList.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(customerOne.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('refuses variant writes to customers', async () => {
    const res = await createVariant({ optionValues: { size: 'M' } }, customerToken);

    expect(res.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });
});
