-- Inventory ledger, contract phase (P1-N.2, ADR-0008). Stock now lives only in "StockLevel", changed through
-- reservations and "StockMovement"; Variant.quantity and "InventoryLog" are dropped. 20261122000000_stock_ledger
-- backfilled both; it ships in the same release.

-- Fail fast instead of dropping stock the backfill has not caught up with: rerun the "-- Backfill" section of
-- 20261122000000_stock_ledger, then this migration.
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT (SELECT count(*) FROM "InventoryLog" l
          WHERE NOT EXISTS (SELECT 1 FROM "StockMovement" m WHERE m.id = 'inventory_log_' || l.id))
       + (SELECT count(*) FROM "Variant" v
          WHERE v.quantity <> COALESCE((SELECT sum(sl."onHand") FROM "StockLevel" sl WHERE sl."variantId" = v.id), 0))
  INTO behind;
  IF behind > 0 THEN
    RAISE EXCEPTION '% inventory log row(s) or variant stock level(s) are not in the stock ledger; rerun the backfill of 20261122000000_stock_ledger first', behind;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "InventoryLog" DROP CONSTRAINT "InventoryLog_productId_fkey";

-- DropForeignKey
ALTER TABLE "InventoryLog" DROP CONSTRAINT "InventoryLog_variantId_fkey";

-- AlterTable (drops the Variant_quantity_non_negative check with its column)
ALTER TABLE "Variant" DROP COLUMN "quantity";

-- DropTable
DROP TABLE "InventoryLog";

-- DropEnum
DROP TYPE "InventoryAction";
