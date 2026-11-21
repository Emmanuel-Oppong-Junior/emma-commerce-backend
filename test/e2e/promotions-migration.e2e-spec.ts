import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261125050000_price_history';
const EXPAND = '20261126000000_promotions';
const CONTRACT = '20261126010000_promotions_contract';
const REPORT = join(__dirname, '../../scripts/reports/promotions-migration-report.sql');
const backfill = () => migrationSqlFrom(EXPAND, '-- Backfill');

// Discounts and coupons as P2-A left them: a discount on a variant, a product and a category at once (with a
// percentage above 100, which the old engine capped at the price), one without targets, a lower-case coupon used once
// and a percentage coupon, a coupon use of a live order and one of an order that no longer exists.
const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-promo@test.local', now()), ('u2', 'legacy-promo2@test.local', now());
INSERT INTO "Category" ("id", "name", "updatedAt") VALUES ('c1', 'Kitchen', now());
INSERT INTO "Product" ("id", "name", "categoryId", "updatedAt") VALUES ('p1', 'Kettle', 'c1', now()), ('p2', 'Mug', NULL, now());
INSERT INTO "Discount" ("id", "name", "description", "type", "value", "startDate", "endDate", "isActive", "minimumPurchase", "createdAt", "updatedAt") VALUES
  ('d_multi', 'Kitchen week', 'All kitchen', 'PERCENTAGE', 150, '2026-01-01', '2026-12-31', true, 40, '2026-01-01', now()),
  ('d_empty', 'Nothing', NULL, 'FLAT', 5, '2026-01-01', '2026-12-31', false, NULL, '2026-01-02', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "discountId", "updatedAt") VALUES
  ('v1', 'p1', 'KETTLE', '', 100, 'd_multi', now()), ('v2', 'p2', 'MUG', '', 20, NULL, now());
UPDATE "Category" SET "discountId" = 'd_multi' WHERE id = 'c1';
INSERT INTO "_DiscountToProduct" ("A", "B") VALUES ('d_multi', 'p2');
INSERT INTO "Coupon" ("id", "code", "discountType", "value", "usageLimit", "usedCount", "expiresAt", "isActive", "minimumOrderAmount", "createdAt", "updatedAt") VALUES
  ('c_once', 'once5', 'FLAT', 5, 2, 1, '2026-12-31', true, 50, '2026-02-01', now()),
  ('c_pct', 'BIG', 'PERCENTAGE', 120, NULL, 0, NULL, false, NULL, '2026-02-02', now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "currency", "pricingVersion", "grandTotal", "couponId", "status", "contactEmail", "contactPhone", "updatedAt") VALUES
  ('o1', 1, 'u1', 'GHS', 0, 95, 'c_once', 'CONFIRMED', 'legacy-promo@test.local', '+233200000000', now());
INSERT INTO "OrderAdjustment" ("id", "orderId", "type", "sourceId", "code", "amount") VALUES
  ('adj_coupon', 'o1', 'COUPON', 'c_once', 'ONCE5', -5), ('adj_discount', 'o1', 'DISCOUNT', 'd_multi', NULL, -10);
INSERT INTO "CouponUsage" ("id", "couponId", "userId", "orderId", "createdAt") VALUES
  ('cu1', 'c_once', 'u1', 'o1', '2026-03-01'), ('cu_orphan', 'c_once', 'u2', 'order_gone', '2026-03-02');
`;

interface PromotionRow {
  id: string;
  name: string;
  scope: string;
  type: string;
  value: string;
  minimumSpend: string | null;
  isActive: boolean;
  requiresCoupon: boolean;
  usageLimit: number | null;
  usedCount: number;
  perCustomerLimit: number | null;
  stackingGroup: string;
  endsAt: Date | null;
}

describe('Promotions migration on legacy discounts and coupons (P2-B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const promotions = () =>
    legacy.query<PromotionRow>(
      `SELECT id, name, scope::text, type::text, value::text, "minimumSpend"::text, "isActive", "requiresCoupon",
              "usageLimit", "usedCount", "perCustomerLimit", "stackingGroup", "endsAt"
       FROM "Promotion" ORDER BY id`,
    );
  const targets = () =>
    legacy.query<{ promotionId: string; targetId: string }>(
      `SELECT "A" AS "promotionId", "B" AS "targetId" FROM "_PromotionToVariant"
       UNION ALL SELECT "B", "A" FROM "_ProductToPromotion"
       UNION ALL SELECT "B", "A" FROM "_CategoryToPromotion"
       ORDER BY 1, 2`,
    );
  const snapshot = async () => ({
    promotions: await promotions(),
    targets: await targets(),
    codes: await legacy.query(`SELECT id, code, "promotionId", "isActive", "usedCount" FROM "CouponCode" ORDER BY id`),
    redemptions: await legacy.query(
      `SELECT id, "promotionId", "couponCodeId", "customerId", "orderId", status::text FROM "Redemption" ORDER BY id`,
    ),
    orders: await legacy.query(`SELECT id, "couponCodeId" FROM "Order" ORDER BY id`),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_promotions');
    await legacy.recreate();
    await legacy.migrateTo(BEFORE);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(EXPAND));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it('turns each discount into automatic promotions, one per kind of target, keeping the id on the first', async () => {
    const rows = (await promotions()).filter((p) => !p.requiresCoupon);

    expect(rows.map((p) => [p.id, p.scope, p.type, p.value, p.minimumSpend, p.isActive, p.stackingGroup])).toEqual([
      ['d_empty', 'PRODUCT', 'AMOUNT_OFF', '5.00', null, false, 'default'],
      ['d_multi', 'SKU', 'PERCENT', '100.00', '40.00', true, 'default'],
      ['d_multi_category', 'CATEGORY', 'PERCENT', '100.00', '40.00', true, 'default'],
      ['d_multi_product', 'PRODUCT', 'PERCENT', '100.00', '40.00', true, 'default'],
    ]);
    expect(rows.every((p) => p.name === (p.id === 'd_empty' ? 'Nothing' : 'Kitchen week'))).toBe(true);
    expect(await targets()).toEqual([
      { promotionId: 'd_multi', targetId: 'v1' },
      { promotionId: 'd_multi_category', targetId: 'c1' },
      { promotionId: 'd_multi_product', targetId: 'p2' },
    ]);
  });

  it('turns each coupon into a CART promotion with one upper-case code, its limits and one use per customer', async () => {
    const rows = (await promotions()).filter((p) => p.requiresCoupon);
    const codes = await legacy.query(
      `SELECT id, code, "promotionId", "isActive", "usedCount" FROM "CouponCode" ORDER BY id`,
    );

    expect(
      rows.map((p) => [p.id, p.scope, p.type, p.value, p.minimumSpend, p.usageLimit, p.usedCount, p.perCustomerLimit]),
    ).toEqual([
      ['c_once', 'CART', 'AMOUNT_OFF', '5.00', '50.00', 2, 1, 1],
      ['c_pct', 'CART', 'PERCENT', '100.00', null, null, 0, 1],
    ]);
    expect(rows.find((p) => p.id === 'c_once')?.endsAt).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    expect(codes).toEqual([
      { id: 'c_once', code: 'ONCE5', promotionId: 'c_once', isActive: true, usedCount: 1 },
      { id: 'c_pct', code: 'BIG', promotionId: 'c_pct', isActive: false, usedCount: 0 },
    ]);
  });

  it("turns the live order's coupon use into a RESERVED redemption and points the order at the code", async () => {
    const { redemptions, orders } = await snapshot();

    expect(redemptions).toEqual([
      { id: 'cu1', promotionId: 'c_once', couponCodeId: 'c_once', customerId: 'u1', orderId: 'o1', status: 'RESERVED' },
    ]);
    expect(orders).toEqual([{ id: 'o1', couponCodeId: 'c_once' }]);
  });

  it("leaves every order adjustment's source naming a promotion", async () => {
    const orphans = await legacy.query(
      `SELECT a.id FROM "OrderAdjustment" a WHERE NOT EXISTS (SELECT 1 FROM "Promotion" p WHERE p.id = a."sourceId")`,
    );

    expect(orphans).toEqual([]);
  });

  it('is safe to run again: the backfill changes nothing the second time', async () => {
    const before = await snapshot();

    await legacy.exec(backfill());

    expect(await snapshot()).toEqual(before);
  });

  it('contracts: drops the old tables and links, and the report runs on what is left', async () => {
    await legacy.exec(migrationSql(CONTRACT));

    const leftovers = await legacy.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'legacy_promotions' AND table_name IN ('Discount', 'Coupon', 'CouponUsage', '_DiscountToProduct')
       UNION ALL
       SELECT table_name || '.' || column_name FROM information_schema.columns
       WHERE table_schema = 'legacy_promotions'
         AND ((table_name IN ('Variant', 'Category', 'CartItem') AND column_name IN ('discountId', 'discountedPrice'))
           OR (table_name = 'Order' AND column_name = 'couponId'))`,
    );
    expect(leftovers).toEqual([]);
    await expect(legacy.exec(readFileSync(REPORT, 'utf8'))).resolves.toBeUndefined();
  });

  it('refuses to contract while a coupon is not migrated', async () => {
    const stale = new ScratchSchema(prisma, 'legacy_promotions_stale');
    await stale.recreate();
    try {
      await stale.migrateTo(BEFORE);
      await stale.exec(LEGACY_DATA);
      await stale.exec(migrationSql(EXPAND));
      await stale.exec(
        `INSERT INTO "Coupon" ("id", "code", "discountType", "value", "updatedAt") VALUES ('c_late', 'LATE', 'FLAT', 1, now())`,
      );

      await expect(stale.exec(migrationSql(CONTRACT))).rejects.toThrow(/not migrated yet/);
    } finally {
      await stale.drop();
    }
  });
});
