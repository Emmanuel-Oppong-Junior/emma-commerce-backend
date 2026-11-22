import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, setStock, stockOf } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';

describe('Stock changes only through logged restock/adjust (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let variantId: string;

  const admin = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, adminToken).expect(200);
  const rejectedBySchema = (query: string) => gqlRequest(app, query, undefined, adminToken).expect(400);
  const defaultVariantStock = async () => (await stockOf(prisma, 'seed_var1')).available;
  const variantStock = async () => (await stockOf(prisma, variantId)).available;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    variantId = (
      await prisma.variant.create({
        data: {
          productId: 'seed_prod1',
          optionValues: { size: 'M' },
          optionsKey: 'size=M',
          price: 999.99,
          sku: 'STOCK-M',
        },
      })
    ).id;
    await setStock(prisma, variantId, 10);
  });

  afterAll(async () => {
    await app.close();
  });

  it('updateProduct no longer accepts quantity, so an edit form cannot overwrite live stock', async () => {
    const before = await defaultVariantStock();

    const res = await rejectedBySchema(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop", quantity: 999 }) { id } }`,
    );

    expect(res.body.errors?.[0].message).toMatch(/quantity/);
    expect(await defaultVariantStock()).toBe(before);
  });

  it('updateProduct still edits other fields', async () => {
    const res = await admin(
      `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop Pro", shortDescription: "Pre-order" }) { name shortDescription } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateProduct).toEqual({ name: 'Laptop Pro', shortDescription: 'Pre-order' });
  });

  it('updateVariant no longer accepts quantity', async () => {
    const res = await rejectedBySchema(
      `mutation { updateVariant(input: { id: "${variantId}", quantity: 999 }) { id } }`,
    );

    expect(res.body.errors?.[0].message).toMatch(/quantity/);
    expect(await variantStock()).toBe(10);
  });

  it('adjustVariantStock removes stock with a reason and logs an ADJUSTMENT', async () => {
    const before = await defaultVariantStock();

    const res = await admin(
      `mutation { adjustVariantStock(input: { variantId: "seed_var1", delta: -3, reason: DAMAGED, note: "Damaged in storage" }) {
        reason onHandDelta reservedDelta note } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.adjustVariantStock).toEqual({
      reason: 'ADJUSTMENT',
      onHandDelta: -3,
      reservedDelta: 0,
      note: 'Damaged in storage',
    });
    expect(await defaultVariantStock()).toBe(before - 3);
  });

  it('adjustVariantStock refuses to go below zero and changes nothing', async () => {
    const before = await defaultVariantStock();
    const logsBefore = await prisma.stockMovement.count({ where: { variantId: 'seed_var1' } });

    const res = await admin(
      `mutation { adjustVariantStock(input: { variantId: "seed_var1", delta: -${before + 1}, reason: LOST }) { id } }`,
    );

    expect(res.body.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(await defaultVariantStock()).toBe(before);
    expect(await prisma.stockMovement.count({ where: { variantId: 'seed_var1' } })).toBe(logsBefore);
  });

  it('adjustVariantStock moves variant stock and records it against the variant', async () => {
    const res = await admin(
      `mutation { adjustVariantStock(input: { variantId: "${variantId}", delta: -4, reason: CORRECTION }) {
        variantId reason onHandDelta } }`,
    );

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.adjustVariantStock).toEqual({ variantId, reason: 'ADJUSTMENT', onHandDelta: -4 });
    expect(await variantStock()).toBe(6);
  });

  it('rejects a zero delta', async () => {
    const res = await admin(
      `mutation { adjustVariantStock(input: { variantId: "seed_var1", delta: 0, reason: CORRECTION }) { id } }`,
    );

    expect(res.body.errors?.[0].extensions.code).toBe('BAD_USER_INPUT');
  });

  it('the database refuses negative variant stock', async () => {
    await expect(
      prisma.$executeRaw`UPDATE "StockLevel" SET "onHand" = -1, "reserved" = 0 WHERE "variantId" = ${variantId}`,
    ).rejects.toThrow(/StockLevel_onHand_non_negative/);
  });
});
