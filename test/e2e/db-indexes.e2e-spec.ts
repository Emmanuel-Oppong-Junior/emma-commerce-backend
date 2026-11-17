import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';

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

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
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
