-- Pickup points, contract phase (P5-E.1): "state" is replaced by "region"; 20261207120000_pickup_points backfilled it.

-- Fail fast instead of dropping a state the backfill has not looked at: rerun the "-- Backfill" section of
-- 20261207120000_pickup_points first.
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT count(*) FROM "PickupLocation" p
  WHERE p."region" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a.entity = 'PickupMigration' AND a."entityId" = p.id)
  INTO behind;
  IF behind > 0 THEN
    RAISE EXCEPTION '% pickup point(s) are not migrated yet; rerun the backfill of 20261207120000_pickup_points first', behind;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "PickupLocation" DROP COLUMN "state";
