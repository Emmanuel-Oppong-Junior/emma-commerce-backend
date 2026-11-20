import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, ScratchSchema } from '../helpers/migration.helper';

const EXPAND = '20261121000000_product_types_and_sku_columns';
const BACKFILL = '20261121010000_default_variants';

// Legacy shapes as they existed before P1-V.2: product-level price and stock, variants with size/color, history
// rows pointing only at products. Inserted after the expand migration, then the backfill runs twice.
const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-buyer@test.local', now());
INSERT INTO "Cart" ("id", "userId", "updatedAt") VALUES ('c1', 'u1', now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "totalAmount", "contactEmail", "contactPhone", "updatedAt")
  VALUES ('o1', 1, 'u1', 10, 'legacy-buyer@test.local', '+233200000000', now());

INSERT INTO "Product" ("id", "name", "price", "basePrice", "quantity", "sku", "barcode", "isTaxable", "updatedAt") VALUES
  ('p_plain', 'Plain mug', 50, 50, 7, 'PLAIN-1', '111', false, now()),
  ('p_sized', 'Shirt', 100, 100, 30, 'SHIRT-1', NULL, false, now()),
  ('p_taxed', 'Taxed kettle', 115, NULL, 2, NULL, NULL, true, now()),
  ('p_noprice', 'Unpriced', NULL, NULL, 1, NULL, NULL, false, now()),
  ('p_general', 'Two plain variants', 20, 20, 0, NULL, NULL, false, now()),
  ('p_pipe', 'Odd size', 30, 30, 0, NULL, NULL, false, now());

INSERT INTO "Variant" ("id", "productId", "size", "color", "quantity", "price", "createdAt", "updatedAt") VALUES
  ('v_s', 'p_sized', 'S', 'Red', 3, 90, '2026-01-01', now()),
  ('v_m', 'p_sized', ' m ', NULL, 4, 95, '2026-01-02', now()),
  ('v_m_dup', 'p_sized', 'M', '', 2, 96, '2026-01-03', now()),
  ('g1', 'p_general', NULL, NULL, 1, 20, '2026-01-01', now()),
  ('g2', 'p_general', NULL, NULL, 1, 21, '2026-01-02', now()),
  ('v_pipe', 'p_pipe', 'S|M', NULL, 1, 30, '2026-01-01', now());

INSERT INTO "OrderItem" ("id", "orderId", "productId", "quantity", "priceAtOrder", "originalPrice") VALUES
  ('oi_plain', 'o1', 'p_plain', 1, 50, 50),
  ('oi_sized', 'o1', 'p_sized', 2, 100, 100),
  ('oi_variant', 'o1', 'p_sized', 1, 90, 90);
UPDATE "OrderItem" SET "variantId" = 'v_s' WHERE id = 'oi_variant';
INSERT INTO "CartItem" ("id", "cartId", "productId", "quantity", "updatedAt") VALUES ('ci_sized', 'c1', 'p_sized', 1, now());
INSERT INTO "InventoryLog" ("id", "productId", "action", "quantityChange", "quantityAfter") VALUES
  ('log_plain', 'p_plain', 'RESTOCK', 7, 7),
  ('log_sized', 'p_sized', 'RESTOCK', 30, 30);
`;

interface VariantRow {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  optionValues: Record<string, string>;
  optionsKey: string;
  quantity: number;
  price: string | null;
  basePrice: string | null;
  isActive: boolean;
}

describe('Variant migration on legacy data (P1-V.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const variants = () =>
    legacy.query<VariantRow>(
      `SELECT id, "productId", sku, barcode, "optionValues", "optionsKey", quantity, price::text AS price,
              "basePrice"::text AS "basePrice", "isActive" FROM "Variant" ORDER BY id`,
    );
  const byId = async () => Object.fromEntries((await variants()).map((v) => [v.id, v]));
  const report = () =>
    legacy.query<{ action: string; productId: string; details: Record<string, unknown> }>(
      `SELECT action, "entityId" AS "productId", details FROM "AuditLog" WHERE entity = 'VariantMigration' ORDER BY id`,
    );
  const variantOf = async (table: string, id: string) =>
    (await legacy.query<{ variantId: string }>(`SELECT "variantId" FROM "${table}" WHERE id = '${id}'`))[0].variantId;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_variant_migration');
    await legacy.recreate();
    await legacy.migrateTo(EXPAND);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(BACKFILL));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it('gives a product without variants one default variant copying its price, base price, stock, SKU and barcode', async () => {
    const v = await byId();

    expect(v.p_plain_default).toMatchObject({
      productId: 'p_plain',
      sku: 'PLAIN-1',
      barcode: '111',
      optionValues: {},
      optionsKey: '',
      quantity: 7,
      price: '50.00',
      basePrice: '50.00',
      isActive: true,
    });
    expect(await variantOf('OrderItem', 'oi_plain')).toBe('p_plain_default');
    expect(await variantOf('InventoryLog', 'log_plain')).toBe('p_plain_default');
  });

  it("keeps a product's variants, their stock and prices, and turns size/color into Apparel options", async () => {
    const v = await byId();
    const [{ productTypeId }] = await legacy.query<{ productTypeId: string }>(
      `SELECT "productTypeId" FROM "Product" WHERE id = 'p_sized'`,
    );

    expect(productTypeId).toBe('product_type_apparel');
    expect(v.v_s).toMatchObject({
      optionValues: { size: 'S', colour: 'Red' },
      optionsKey: 'colour=red|size=s',
      quantity: 3,
      price: '90.00',
      basePrice: '90.00',
      isActive: true,
      sku: 'SKU-V_S',
    });
    expect(v.v_m).toMatchObject({ optionValues: { size: 'm' }, optionsKey: 'size=m', quantity: 4, isActive: true });
    expect(v.p_sized_default).toBeUndefined();
    expect(await variantOf('OrderItem', 'oi_variant')).toBe('v_s');
  });

  it('archives the younger of two variants with the same options and reports it', async () => {
    const v = await byId();

    expect(v.v_m_dup).toMatchObject({ optionsKey: 'size=m', isActive: false, quantity: 2 });
    expect(v.g1.isActive).toBe(true);
    expect(v.g2.isActive).toBe(false);
    expect(await report()).toEqual(
      expect.arrayContaining([
        {
          action: 'DUPLICATE_OPTIONS_ARCHIVED',
          productId: 'p_sized',
          details: { variantId: 'v_m_dup', keptVariantId: 'v_m', optionsKey: 'size=m' },
        },
        {
          action: 'DUPLICATE_OPTIONS_ARCHIVED',
          productId: 'p_general',
          details: { variantId: 'g2', keptVariantId: 'g1', optionsKey: '' },
        },
      ]),
    );
  });

  it('anchors history recorded against a product with variants on an archived zero-stock Legacy variant', async () => {
    const v = await byId();

    expect(v.p_sized_legacy).toMatchObject({ quantity: 0, isActive: false, sku: 'LEGACY-P_SIZED', optionsKey: '' });
    expect(await variantOf('OrderItem', 'oi_sized')).toBe('p_sized_legacy');
    expect(await variantOf('CartItem', 'ci_sized')).toBe('p_sized_legacy');
    expect(await variantOf('InventoryLog', 'log_sized')).toBe('p_sized_legacy');
    expect(v.p_general_legacy).toBeUndefined();
  });

  it('reports what it could not map, never guessing money', async () => {
    const v = await byId();
    const rows = await report();

    expect(rows).toEqual(
      expect.arrayContaining([
        {
          action: 'PRODUCT_STOCK_PRICE_DROPPED',
          productId: 'p_sized',
          details: {
            productQuantity: 30,
            productPrice: '100.00',
            productBasePrice: '100.00',
            variantCount: 3,
            variantQuantity: 9,
          },
        },
        { action: 'SWITCHED_TO_APPAREL', productId: 'p_sized', details: { from: 'product_type_general' } },
        {
          action: 'LEGACY_VARIANT_CREATED',
          productId: 'p_sized',
          details: { variantId: 'p_sized_legacy', cartItems: 1, orderItems: 1, inventoryLogs: 1 },
        },
        {
          action: 'MISSING_BASE_PRICE',
          productId: 'p_taxed',
          details: { variantId: 'p_taxed_default', price: '115.00' },
        },
        {
          action: 'DEFAULT_VARIANT_WITHOUT_PRICE',
          productId: 'p_noprice',
          details: { variantId: 'p_noprice_default' },
        },
        {
          action: 'OPTIONS_NOT_MAPPED',
          productId: 'p_pipe',
          details: { variantId: 'v_pipe', reason: 'size or colour longer than 200 characters or containing "|"' },
        },
      ]),
    );
    expect(v.p_taxed_default).toMatchObject({ price: '115.00', basePrice: null, isActive: true });
    expect(v.p_noprice_default).toMatchObject({ price: null, isActive: false });
    expect(v.v_pipe).toMatchObject({ optionValues: {}, isActive: false });
  });

  it('changes nothing when run again', async () => {
    const before = { variants: await variants(), report: await report() };

    await legacy.exec(migrationSql(BACKFILL));

    expect(await variants()).toEqual(before.variants);
    expect(await report()).toEqual(before.report);
  });

  it('enforces one active variant per option combination in the database', async () => {
    await expect(
      legacy.exec(
        `INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "updatedAt") VALUES ('v_m3', 'p_sized', 'X-3', 'size=m', 1, now())`,
      ),
    ).rejects.toThrow(/Variant_productId_optionsKey_key/);
    await legacy.exec(
      `INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "isActive", "updatedAt") VALUES ('v_m4', 'p_sized', 'X-4', 'size=m', 1, false, now())`,
    );
  });
});
