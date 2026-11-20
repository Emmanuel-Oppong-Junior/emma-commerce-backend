import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

const BEFORE = '20261121020000_variant_contract';
const LEDGER = '20261122000000_stock_ledger';
const CONTRACT = '20261122010000_stock_ledger_contract';
const backfill = () => migrationSqlFrom(LEDGER, '-- Backfill');

// Stock as the variant (SKU) model left it: Variant.quantity plus an InventoryLog history that does not always add up,
// and open orders whose stock was already taken off Variant.quantity at placement.
const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-ledger@test.local', now());
INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "quantity", "price", "updatedAt") VALUES
  ('v_logged', 'p1', 'LOGGED', 'size=s', 7, 10, now()),
  ('v_unlogged', 'p1', 'UNLOGGED', 'size=m', 5, 10, now()),
  ('v_mismatch', 'p1', 'MISMATCH', 'size=l', 3, 10, now()),
  ('v_zero', 'p1', 'ZERO', 'size=xl', 0, 10, now());
INSERT INTO "InventoryLog" ("id", "productId", "variantId", "action", "quantityChange", "quantityAfter", "reason", "actorId", "createdAt") VALUES
  ('l1', 'p1', 'v_logged', 'RESTOCK', 10, 10, 'Delivery', 'admin1', '2026-01-01'),
  ('l2', 'p1', 'v_logged', 'ORDER_DEDUCTION', -3, 7, 'Order placed', 'u1', '2026-01-02'),
  ('l3', 'p1', 'v_mismatch', 'RESTOCK', 5, 5, NULL, NULL, '2026-01-01'),
  ('l4', 'p1', 'v_mismatch', 'ADJUSTMENT', -1, 4, 'Damaged', 'admin1', '2026-01-03'),
  ('l5', 'p1', 'v_mismatch', 'RETURN_RESTORE', 0, 4, 'Order x cancelled', NULL, '2026-01-04');
INSERT INTO "Order" ("id", "orderNumber", "userId", "totalAmount", "status", "contactEmail", "contactPhone", "updatedAt") VALUES
  ('o_pending', 1, 'u1', 10, 'PENDING', 'legacy-ledger@test.local', '+233200000000', now()),
  ('o_processing', 2, 'u1', 20, 'PROCESSING', 'legacy-ledger@test.local', '+233200000000', now()),
  ('o_delivered', 3, 'u1', 10, 'DELIVERED', 'legacy-ledger@test.local', '+233200000000', now()),
  ('o_cancelled', 4, 'u1', 10, 'CANCELLED', 'legacy-ledger@test.local', '+233200000000', now());
INSERT INTO "OrderItem" ("id", "orderId", "productId", "variantId", "quantity", "priceAtOrder", "originalPrice") VALUES
  ('oi_pending', 'o_pending', 'p1', 'v_logged', 1, 10, 10),
  ('oi_processing', 'o_processing', 'p1', 'v_logged', 2, 10, 10),
  ('oi_delivered', 'o_delivered', 'p1', 'v_logged', 1, 10, 10),
  ('oi_cancelled', 'o_cancelled', 'p1', 'v_unlogged', 1, 10, 10);
`;

interface LevelRow {
  variantId: string;
  locationId: string;
  onHand: number;
  reserved: number;
}

describe('Stock ledger migration on legacy data (P1-N.1/N.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let legacy: ScratchSchema;

  const levels = async () =>
    Object.fromEntries(
      (
        await legacy.query<LevelRow>(
          `SELECT "variantId", "locationId", "onHand", reserved FROM "StockLevel" ORDER BY "variantId"`,
        )
      ).map((l) => [l.variantId, l]),
    );
  const movements = () =>
    legacy.query<{ id: string; variantId: string; onHandDelta: number; reason: string; refId: string | null }>(
      `SELECT id, "variantId", "onHandDelta", reason, "refId" FROM "StockMovement" ORDER BY "createdAt", id`,
    );
  const openingBalances = async () =>
    (await movements()).filter((m) => m.reason === 'OPENING_BALANCE').map((m) => [m.variantId, m.onHandDelta]);
  const report = () =>
    legacy.query<{ variantId: string; details: Record<string, unknown> }>(
      `SELECT "entityId" AS "variantId", details FROM "AuditLog" WHERE entity = 'StockLedgerMigration' ORDER BY "createdAt", "entityId"`,
    );
  const ledgerGaps = () =>
    legacy.query<{ variantId: string }>(
      `SELECT sl."variantId" FROM "StockLevel" sl
       LEFT JOIN (SELECT "variantId", "locationId", sum("onHandDelta") AS total FROM "StockMovement" GROUP BY 1, 2) m
         ON m."variantId" = sl."variantId" AND m."locationId" = sl."locationId"
       WHERE sl."onHand" <> COALESCE(m.total, 0)`,
    );
  const snapshot = async () => ({
    levels: await levels(),
    movements: await movements(),
    report: await report(),
    reservations: await legacy.query(`SELECT id, status FROM "StockReservation" ORDER BY id`),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    legacy = new ScratchSchema(prisma, 'legacy_stock_ledger');
    await legacy.recreate();
    await legacy.migrateTo(BEFORE);
    await legacy.exec(LEGACY_DATA);
    await legacy.exec(migrationSql(LEDGER));
  });

  afterAll(async () => {
    await legacy.drop();
    await app.close();
  });

  it("creates one default location for the store and puts every variant's stock there", async () => {
    const locations = await legacy.query<{ id: string; storeId: string; isDefault: boolean; type: string }>(
      `SELECT id, "storeId", "isDefault", type FROM "StockLocation"`,
    );
    const l = await levels();

    expect(locations).toEqual([{ id: 'store_main', storeId: 'store', isDefault: true, type: 'WAREHOUSE' }]);
    expect(l).toEqual({
      v_logged: { variantId: 'v_logged', locationId: 'store_main', onHand: 7, reserved: 0 },
      v_mismatch: { variantId: 'v_mismatch', locationId: 'store_main', onHand: 3, reserved: 0 },
      v_unlogged: { variantId: 'v_unlogged', locationId: 'store_main', onHand: 5, reserved: 0 },
      v_zero: { variantId: 'v_zero', locationId: 'store_main', onHand: 0, reserved: 0 },
    });
  });

  it('copies every inventory log row into the ledger with its reason mapped', async () => {
    const copied = (await movements()).filter((m) => m.reason !== 'OPENING_BALANCE');

    expect(copied.map((m) => [m.id, m.onHandDelta, m.reason, m.refId])).toEqual([
      ['inventory_log_l1', 10, 'RECEIPT', 'l1'],
      ['inventory_log_l3', 5, 'RECEIPT', 'l3'],
      ['inventory_log_l2', -3, 'SALE', 'l2'],
      ['inventory_log_l4', -1, 'ADJUSTMENT', 'l4'],
      ['inventory_log_l5', 0, 'RETURN_RESTOCK', 'l5'],
    ]);
  });

  it('balances what the history does not explain with an opening balance and reports it, ids and counts only', async () => {
    expect(await openingBalances()).toEqual(
      expect.arrayContaining([
        ['v_unlogged', 5],
        ['v_mismatch', -1],
      ]),
    );
    expect(await openingBalances()).toHaveLength(2);
    expect(await ledgerGaps()).toEqual([]);
    expect(await report()).toEqual(
      expect.arrayContaining([
        { variantId: 'v_unlogged', details: { locationId: 'store_main', onHand: 5, history: 0, difference: 5 } },
        { variantId: 'v_mismatch', details: { locationId: 'store_main', onHand: 3, history: 4, difference: -1 } },
      ]),
    );
  });

  it('records the lines of open orders as consumed reservations, so a later cancel restores their stock once', async () => {
    const reservations = await legacy.query<{ id: string; orderId: string; quantity: number; status: string }>(
      `SELECT id, "orderId", quantity, status FROM "StockReservation" ORDER BY id`,
    );

    expect(reservations).toEqual([
      { id: 'legacy_oi_pending', orderId: 'o_pending', quantity: 1, status: 'CONSUMED' },
      { id: 'legacy_oi_processing', orderId: 'o_processing', quantity: 2, status: 'CONSUMED' },
    ]);
  });

  it('changes nothing when run again', async () => {
    const before = await snapshot();

    await legacy.exec(backfill());

    expect(await snapshot()).toEqual(before);
  });

  it('catches up with stock changes made through the old columns since it last ran', async () => {
    await legacy.exec(`
      INSERT INTO "InventoryLog" ("id", "productId", "variantId", "action", "quantityChange", "quantityAfter")
        VALUES ('l6', 'p1', 'v_logged', 'RESTOCK', 2, 9);
      UPDATE "Variant" SET quantity = 9 WHERE id = 'v_logged';
      UPDATE "Variant" SET quantity = 4 WHERE id = 'v_zero';
    `);

    await legacy.exec(backfill());

    const l = await levels();
    expect([l.v_logged.onHand, l.v_zero.onHand]).toEqual([9, 4]);
    expect((await movements()).find((m) => m.id === 'inventory_log_l6')).toMatchObject({ onHandDelta: 2 });
    expect(await openingBalances()).toEqual(expect.arrayContaining([['v_zero', 4]]));
    expect(await openingBalances()).toHaveLength(3);
    expect(await ledgerGaps()).toEqual([]);
  });

  it('rejects negative stock and reserving more than is on hand in the database', async () => {
    await expect(
      legacy.exec(`UPDATE "StockLevel" SET "onHand" = -1, reserved = 0 WHERE "variantId" = 'v_zero'`),
    ).rejects.toThrow(/StockLevel_onHand_non_negative/);
    await expect(legacy.exec(`UPDATE "StockLevel" SET reserved = -1 WHERE "variantId" = 'v_zero'`)).rejects.toThrow(
      /StockLevel_reserved_non_negative/,
    );
    await expect(
      legacy.exec(`UPDATE "StockLevel" SET reserved = "onHand" + 1 WHERE "variantId" = 'v_zero'`),
    ).rejects.toThrow(/StockLevel_reserved_within_on_hand/);
  });

  it('keeps the ledger append-only, while deleting a product still removes its movements', async () => {
    await expect(legacy.exec(`UPDATE "StockMovement" SET "onHandDelta" = 100`)).rejects.toThrow(/append-only/);
    await expect(legacy.exec(`DELETE FROM "StockMovement" WHERE "variantId" = 'v_zero'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      legacy.exec(
        `INSERT INTO "StockLocation" ("id", "storeId", "name", "isDefault", "updatedAt") VALUES ('second', 'store', 'Second', true, now())`,
      ),
    ).rejects.toThrow(/StockLocation_one_default_per_store/);

    await legacy.exec(`
      INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p_gone', 'Gone', now());
      INSERT INTO "Variant" ("id", "productId", "sku", "quantity", "price", "updatedAt") VALUES ('v_gone', 'p_gone', 'GONE', 1, 1, now());
    `);
    await legacy.exec(backfill());
    await legacy.exec(`DELETE FROM "Product" WHERE id = 'p_gone'`);

    expect((await movements()).filter((m) => m.variantId === 'v_gone')).toEqual([]);
  });
  it('refuses to contract while the old stock columns are ahead of the ledger, then drops them once caught up', async () => {
    await legacy.exec(`UPDATE "Variant" SET quantity = quantity + 1 WHERE id = 'v_logged'`);

    await expect(legacy.exec(migrationSql(CONTRACT))).rejects.toThrow(
      /rerun the backfill of 20261122000000_stock_ledger/,
    );

    await legacy.exec(backfill());
    await legacy.exec(migrationSql(CONTRACT));

    const tables = await legacy.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'legacy_stock_ledger' AND table_name = 'InventoryLog'`,
    );
    const columns = await legacy.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'legacy_stock_ledger' AND table_name = 'Variant' AND column_name = 'quantity'`,
    );
    expect([tables, columns]).toEqual([[], []]);
    expect((await levels()).v_logged.onHand).toBe(10);
    expect(await ledgerGaps()).toEqual([]);
  });
});
