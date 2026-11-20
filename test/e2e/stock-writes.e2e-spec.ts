import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

describe('Stock changes only through logged restock/adjust (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let variantId: string;

  const admin = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, adminToken).expect(200);
  const rejectedBySchema = (query: string) => gqlRequest(app, query, undefined, adminToken).expect(400);
  const productStock = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' }, select: { quantity: true } })).quantity;
  const variantStock = async () =>
    (await prisma.variant.findUniqueOrThrow({ where: { id: variantId }, select: { quantity: true } })).quantity;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    variantId = (
      await prisma.variant.create({
        data: { productId: 'seed_prod1', size: 'M', quantity: 10, price: 999.99, sku: 'STOCK-M' },
      })
    ).id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('updateProduct no longer accepts quantity, so an edit form cannot overwrite live stock', async () => {
    const before = await productStock();

    const res = await rejectedBySchema(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop", quantity: 999 }) { id } }`,
    );

    expect(res.body.errors?.[0].message).toMatch(/quantity/);
    expect(await productStock()).toBe(before);
  });

  it('updateProduct still edits other fields, including stockStatus', async () => {
    const res = await admin(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop Pro", stockStatus: PREORDER }) { name stockStatus } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateProduct).toEqual({ name: 'Laptop Pro', stockStatus: 'PREORDER' });
  });

  it('updateVariant no longer accepts quantity', async () => {
    const res = await rejectedBySchema(
      `mutation { updateVariant(input: { id: "${variantId}", quantity: 999 }) { id } }`,
    );

    expect(res.body.errors?.[0].message).toMatch(/quantity/);
    expect(await variantStock()).toBe(10);
  });

  it('adjustProductStock removes stock with a reason and logs an ADJUSTMENT', async () => {
    const before = await productStock();

    const res = await admin(
      `mutation { adjustProductStock(input: { productId: "seed_prod1", delta: -3, reason: "Damaged in storage" }) {
        action quantityChange quantityAfter reason } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.adjustProductStock).toEqual({
      action: 'ADJUSTMENT',
      quantityChange: -3,
      quantityAfter: before - 3,
      reason: 'Damaged in storage',
    });
    expect(await productStock()).toBe(before - 3);
  });

  it('adjustProductStock refuses to go below zero and changes nothing', async () => {
    const before = await productStock();
    const logsBefore = await prisma.inventoryLog.count({ where: { productId: 'seed_prod1' } });

    const res = await admin(
      `mutation { adjustProductStock(input: { productId: "seed_prod1", delta: -${before + 1}, reason: "Write-off" }) { id } }`,
    );

    expect(res.body.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(await productStock()).toBe(before);
    expect(await prisma.inventoryLog.count({ where: { productId: 'seed_prod1' } })).toBe(logsBefore);
  });

  it('adjustVariantStock moves variant stock and logs it against the product', async () => {
    const res = await admin(
      `mutation { adjustVariantStock(input: { variantId: "${variantId}", delta: -4, reason: "Stock count" }) {
        productId variantId action quantityAfter } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.adjustVariantStock).toEqual({
      productId: 'seed_prod1',
      variantId,
      action: 'ADJUSTMENT',
      quantityAfter: 6,
    });
  });

  it('rejects a zero delta', async () => {
    const res = await admin(
      `mutation { adjustProductStock(input: { productId: "seed_prod1", delta: 0, reason: "Nothing" }) { id } }`,
    );

    expect(res.body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('the database refuses negative product and variant stock', async () => {
    await expect(prisma.$executeRaw`UPDATE "Product" SET quantity = -1 WHERE id = 'seed_prod1'`).rejects.toThrow(
      /Product_quantity_non_negative/,
    );
    await expect(prisma.$executeRaw`UPDATE "Variant" SET quantity = -1 WHERE id = ${variantId}`).rejects.toThrow(
      /Variant_quantity_non_negative/,
    );
  });
});
