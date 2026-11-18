import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';

describe('Hot-query indexes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const indexNames = async (): Promise<string[]> =>
    (await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`).map(
      (r) => r.indexname,
    );

  // The test tables are tiny, so the planner would pick a sequential scan anyway; turning it off shows
  // whether a usable index exists for the predicate.
  const planFor = async (sql: string): Promise<string> =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(`EXPLAIN ${sql}`);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    });

  // On empty tables OrderItem_orderId_idx and OrderItem_productId_orderId_idx cost the same, so the planner picked
  // either. With realistic, analyzed data the single-column index is the cheaper one and the plan is stable.
  const seedOrderItems = async (): Promise<void> => {
    const { userIds } = await seedMinimal(prisma);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "Product" ("id", "name", "updatedAt")
      SELECT 'idx_p_' || g, 'Index product ' || g, now() FROM generate_series(1, 200) g`);
    // Order numbers come from the store counter: take a block of 500 and number the orders inside it.
    const [{ first }] = await prisma.$queryRaw<{ first: number }[]>`
      UPDATE "Store" SET "nextOrderNumber" = "nextOrderNumber" + 500 WHERE "singleton"
      RETURNING "nextOrderNumber" - 500 AS "first"`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Order" ("id", "orderNumber", "userId", "totalAmount", "contactEmail", "contactPhone", "updatedAt")
       SELECT 'idx_o_' || g, $2 + g - 1, $1, 10, 'index@example.com', '0240000000', now() FROM generate_series(1, 500) g`,
      userIds.userId,
      first,
    );
    await prisma.$executeRawUnsafe(`
      INSERT INTO "OrderItem" ("id", "orderId", "productId", "priceAtOrder", "originalPrice")
      SELECT 'idx_i_' || g, 'idx_o_' || (g % 500 + 1), 'idx_p_' || (g % 200 + 1), 10, 10
      FROM generate_series(1, 5000) g`);
    await prisma.$executeRawUnsafe('ANALYZE "OrderItem"');
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedOrderItems();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('has the indexes the order, expiry and analytics queries need', async () => {
    expect(await indexNames()).toEqual(
      expect.arrayContaining(['OrderItem_orderId_idx', 'Order_createdAt_idx', 'Order_status_createdAt_idx']),
    );
  });

  it('no longer keeps indexes that duplicate a unique key or that no query uses', async () => {
    const names = await indexNames();
    for (const dropped of [
      'RefreshToken_tokenHash_idx',
      'Product_sku_idx',
      'Coupon_code_idx',
      'CouponUsage_couponId_idx',
      'Order_userId_idx',
      'Order_deleted_idx',
      'Order_trackingNumber_idx',
      'ReturnRequest_status_idx',
      'InventoryLog_action_idx',
    ]) {
      expect(names).not.toContain(dropped);
    }
  });

  it('loads an order’s items through the orderId index', async () => {
    expect(await planFor(`SELECT * FROM "OrderItem" WHERE "orderId" = 'o1'`)).toContain('OrderItem_orderId_idx');
  });

  // With empty test tables Postgres chooses between equally cheap indexes arbitrarily, so the Order indexes
  // are checked by definition rather than by plan.
  it('indexes Order by createdAt alone and by status then createdAt', async () => {
    const defs = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'Order' AND indexname IN ('Order_createdAt_idx', 'Order_status_createdAt_idx')`;
    const byName = Object.fromEntries(defs.map((d) => [d.indexname, d.indexdef]));

    expect(byName['Order_createdAt_idx']).toMatch(/\("createdAt"\)$/);
    expect(byName['Order_status_createdAt_idx']).toMatch(/\(status, "createdAt"\)$/);
  });
});
