-- Inventory ledger, expand + backfill (P1-N.1, ADR-0008): stock locations, stock levels per (variant, location),
-- reservations per order line and an append-only movement ledger. The application keeps using Variant.quantity and
-- InventoryLog until 20261122010000_stock_ledger_contract switches to these tables and drops them.

-- CreateEnum
CREATE TYPE "StockLocationType" AS ENUM ('WAREHOUSE', 'BRANCH', 'PICKUP_POINT');

-- CreateEnum
CREATE TYPE "StockReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "StockMovementReason" AS ENUM ('OPENING_BALANCE', 'RECEIPT', 'SALE', 'RETURN_RESTOCK', 'ADJUSTMENT', 'TRANSFER', 'RESERVE', 'RELEASE');

-- CreateTable
CREATE TABLE "StockLocation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "StockLocationType" NOT NULL DEFAULT 'WAREHOUSE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockLevel" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockReservation" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "StockReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHandDelta" INTEGER NOT NULL,
    "reservedDelta" INTEGER NOT NULL DEFAULT 0,
    "reason" "StockMovementReason" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StockLocation_one_default_per_store" ON "StockLocation"("storeId") WHERE ("isDefault");

-- CreateIndex
CREATE INDEX "StockLevel_locationId_idx" ON "StockLevel"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "StockLevel_variantId_locationId_key" ON "StockLevel"("variantId", "locationId");

-- CreateIndex
CREATE INDEX "StockReservation_orderId_idx" ON "StockReservation"("orderId");

-- CreateIndex
CREATE INDEX "StockReservation_variantId_locationId_status_idx" ON "StockReservation"("variantId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "StockReservation_orderItemId_locationId_key" ON "StockReservation"("orderItemId", "locationId");

-- CreateIndex
CREATE INDEX "StockMovement_variantId_createdAt_idx" ON "StockMovement"("variantId", "createdAt");

-- CreateIndex
CREATE INDEX "StockMovement_locationId_idx" ON "StockMovement"("locationId");

-- CreateIndex
CREATE INDEX "StockMovement_refType_refId_idx" ON "StockMovement"("refType", "refId");

-- CreateIndex
CREATE INDEX "StockMovement_createdAt_idx" ON "StockMovement"("createdAt");

-- AddForeignKey
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The database is the last guard against overselling and double releases (ADR-0008).
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_onHand_non_negative" CHECK ("onHand" >= 0);
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_non_negative" CHECK ("reserved" >= 0);
ALTER TABLE "StockLevel" ADD CONSTRAINT "StockLevel_reserved_within_on_hand" CHECK ("reserved" <= "onHand");
ALTER TABLE "StockReservation" ADD CONSTRAINT "StockReservation_quantity_positive" CHECK ("quantity" > 0);

-- The ledger is append-only. Deleting a variant (or its product) still removes its movements: those deletes run
-- inside the foreign-key cascade trigger, so they are nested one trigger level deeper than a direct DELETE.
CREATE FUNCTION "stock_movement_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'StockMovement is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "StockMovement_append_only" BEFORE UPDATE OR DELETE ON "StockMovement"
  FOR EACH ROW EXECUTE FUNCTION "stock_movement_append_only"();

-- Backfill, safe to re-run while Variant.quantity and InventoryLog still exist (20261122010000_stock_ledger_contract
-- refuses to drop them until this has caught up). It:
--   * creates the store's default location ("<storeId>_main"), where all stock lives for now;
--   * copies every InventoryLog row into StockMovement (id "inventory_log_<id>", RESTOCK -> RECEIPT,
--     ORDER_DEDUCTION -> SALE, RETURN_RESTORE -> RETURN_RESTOCK, ADJUSTMENT -> ADJUSTMENT);
--   * sets each variant's StockLevel at the default location to onHand = Variant.quantity, reserved = 0;
--   * records lines of open (PENDING / PROCESSING) orders as CONSUMED reservations ("legacy_<orderItemId>"): the old
--     model already took their stock off Variant.quantity at placement, so cancelling them puts it back exactly once;
--   * writes an OPENING_BALANCE movement for whatever onHand the copied history does not explain, so that the sum of
--     movements equals onHand, and reports it in "AuditLog" (entity 'StockLedgerMigration', ids and counts only).
-- Read the report with scripts/reports/stock-ledger-migration-report.sql.

INSERT INTO "StockLocation" ("id", "storeId", "name", "type", "isActive", "isDefault", "updatedAt")
SELECT s.id || '_main', s.id, 'Main warehouse', 'WAREHOUSE', true, true, CURRENT_TIMESTAMP
FROM "Store" s
WHERE NOT EXISTS (SELECT 1 FROM "StockLocation" l WHERE l."storeId" = s.id AND l."isDefault");

CREATE TEMP TABLE ledger_default_location ON COMMIT DROP AS
SELECT l.id FROM "StockLocation" l JOIN "Store" s ON s.id = l."storeId" WHERE s."singleton" AND l."isDefault";

INSERT INTO "StockMovement" ("id", "variantId", "locationId", "onHandDelta", "reservedDelta", "reason", "refType",
                             "refId", "actorId", "note", "createdAt")
SELECT 'inventory_log_' || l.id, l."variantId", d.id, l."quantityChange", 0,
       (CASE l.action
          WHEN 'RESTOCK' THEN 'RECEIPT'
          WHEN 'ORDER_DEDUCTION' THEN 'SALE'
          WHEN 'RETURN_RESTORE' THEN 'RETURN_RESTOCK'
          ELSE 'ADJUSTMENT'
        END)::"StockMovementReason",
       'InventoryLog', l.id, l."actorId", l.reason, l."createdAt"
FROM "InventoryLog" l CROSS JOIN ledger_default_location d
ON CONFLICT ("id") DO NOTHING;

-- Nothing reserves stock before the switch, so reserved is always 0 here.
INSERT INTO "StockLevel" ("id", "variantId", "locationId", "onHand", "reserved", "updatedAt")
SELECT v.id || '_' || d.id, v.id, d.id, v.quantity, 0, CURRENT_TIMESTAMP
FROM "Variant" v CROSS JOIN ledger_default_location d
ON CONFLICT ("variantId", "locationId") DO UPDATE
  SET "onHand" = EXCLUDED."onHand", "version" = "StockLevel"."version" + 1, "updatedAt" = CURRENT_TIMESTAMP
  WHERE "StockLevel"."onHand" <> EXCLUDED."onHand";

INSERT INTO "StockReservation" ("id", "variantId", "locationId", "orderId", "orderItemId", "quantity", "status",
                                "updatedAt")
SELECT 'legacy_' || oi.id, oi."variantId", d.id, oi."orderId", oi.id, oi.quantity, 'CONSUMED', CURRENT_TIMESTAMP
FROM "OrderItem" oi
JOIN "Order" o ON o.id = oi."orderId"
CROSS JOIN ledger_default_location d
WHERE o.status IN ('PENDING', 'PROCESSING') AND NOT o.deleted AND oi.quantity > 0
ON CONFLICT DO NOTHING;

CREATE TEMP TABLE ledger_gaps ON COMMIT DROP AS
SELECT sl."variantId", sl."locationId", sl."onHand", COALESCE(m.history, 0) AS history,
       sl."onHand" - COALESCE(m.history, 0) AS gap
FROM "StockLevel" sl
LEFT JOIN (
  SELECT "variantId", "locationId", sum("onHandDelta") AS history
  FROM "StockMovement"
  GROUP BY "variantId", "locationId"
) m ON m."variantId" = sl."variantId" AND m."locationId" = sl."locationId"
WHERE sl."onHand" <> COALESCE(m.history, 0);

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'stock_ledger_migration_' || gen_random_uuid(), 'StockLedgerMigration', g."variantId", 'OPENING_BALANCE',
       jsonb_build_object('locationId', g."locationId", 'onHand', g."onHand", 'history', g.history,
                          'difference', g.gap)
FROM ledger_gaps g;

INSERT INTO "StockMovement" ("id", "variantId", "locationId", "onHandDelta", "reservedDelta", "reason", "refType",
                             "note")
SELECT 'opening_balance_' || gen_random_uuid(), g."variantId", g."locationId", g.gap, 0, 'OPENING_BALANCE',
       'StockLedgerMigration', 'Stock the inventory log history did not explain'
FROM ledger_gaps g;

DO $$
DECLARE
  summary text;
BEGIN
  SELECT format('levels: %s, movements copied from InventoryLog: %s, legacy reservations: %s, opening balances: %s',
                (SELECT count(*) FROM "StockLevel"),
                (SELECT count(*) FROM "StockMovement" WHERE "refType" = 'InventoryLog'),
                (SELECT count(*) FROM "StockReservation" WHERE id LIKE 'legacy\_%'),
                (SELECT count(*) FROM "StockMovement" WHERE reason = 'OPENING_BALANCE'))
  INTO summary;
  RAISE NOTICE 'Stock ledger migration (scripts/reports/stock-ledger-migration-report.sql): %', summary;
END $$;
