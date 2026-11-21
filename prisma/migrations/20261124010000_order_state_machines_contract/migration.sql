-- Order state machines, contract phase (P1-O.2). Tracking number and carrier live on the shipment now; the Order
-- columns are dropped. 20261124000000_order_state_machines copied them; it ships in the same release.

-- Fail fast instead of dropping tracking the backfill has not copied: rerun the "-- Backfill" section of
-- 20261124000000_order_state_machines, then this migration.
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT count(*) INTO behind FROM "Order" o
  WHERE (o."trackingNumber" IS NOT NULL OR o.carrier IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s."orderId" = o.id);
  IF behind > 0 THEN
    RAISE EXCEPTION '% order(s) with a tracking number or carrier have no shipment yet; rerun the backfill of 20261124000000_order_state_machines first', behind;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "carrier",
DROP COLUMN "trackingNumber";
