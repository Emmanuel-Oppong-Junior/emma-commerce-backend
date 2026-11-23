-- Pickup points with hours and contacts, expand + backfill (P5-E.1, PCK-03). A point gets a Ghana region (replacing
-- the free-text state), a contact phone, instructions, an optional GhanaPost GPS code and coordinates, and opening
-- hours per weekday. 20261207120100_pickup_points_contract drops "state"; it ships in the same release.

-- AlterTable
ALTER TABLE "PickupLocation" ADD COLUMN     "contactPhone" TEXT,
ADD COLUMN     "ghanaPostGps" TEXT,
ADD COLUMN     "instructions" TEXT,
ADD COLUMN     "latitude" DECIMAL(9,6),
ADD COLUMN     "longitude" DECIMAL(9,6),
ADD COLUMN     "region" "GhanaRegion";

-- CreateTable
CREATE TABLE "PickupOpeningHours" (
    "pickupLocationId" TEXT NOT NULL,
    "weekday" "Weekday" NOT NULL,
    "opensMinute" INTEGER NOT NULL,
    "closesMinute" INTEGER NOT NULL,

    CONSTRAINT "PickupOpeningHours_pkey" PRIMARY KEY ("pickupLocationId","weekday")
);

-- AddForeignKey
ALTER TABLE "PickupOpeningHours" ADD CONSTRAINT "PickupOpeningHours_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "PickupLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PickupOpeningHours" ADD CONSTRAINT "PickupOpeningHours_minutes_check"
  CHECK ("opensMinute" >= 0 AND "closesMinute" <= 1440 AND "opensMinute" < "closesMinute");

-- Backfill, safe to re-run while "state" exists. The state is upper-cased, every run of non-letters becomes "_", and a
-- trailing "_REGION" is dropped; it maps when that is a region's name ("Greater Accra", "greater-accra region") or
-- "GA"/"GAR"/"ACCRA" (Greater Accra). Anything else (e.g. "Brong Ahafo", now split into three regions) keeps region
-- null and is written to "AuditLog" (entity 'PickupMigration', no personal data); read it with
-- scripts/reports/pickup-points-migration-report.sql.
CREATE TEMP TABLE pickup_states ON COMMIT DROP AS
SELECT p.id, p."state",
       CASE
         WHEN s.norm IN ('GA', 'GAR', 'ACCRA') THEN 'GREATER_ACCRA'
         WHEN s.norm IN (SELECT unnest(enum_range(NULL::"GhanaRegion"))::text) THEN s.norm
       END AS region
FROM "PickupLocation" p
CROSS JOIN LATERAL (
  SELECT regexp_replace(btrim(regexp_replace(upper(coalesce(p."state", '')), '[^A-Z]+', '_', 'g'), '_'), '_REGION$', '') AS norm
) s;

UPDATE "PickupLocation" p
SET "region" = ps.region::"GhanaRegion"
FROM pickup_states ps
WHERE ps.id = p.id AND ps.region IS NOT NULL AND p."region" IS NULL;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'pickup_migration_' || ps.id, 'PickupMigration', ps.id, 'STATE_NOT_MAPPED', jsonb_build_object('state', ps."state")
FROM pickup_states ps
JOIN "PickupLocation" p ON p.id = ps.id
WHERE ps.region IS NULL AND p."region" IS NULL
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE 'Pickup points migration (scripts/reports/pickup-points-migration-report.sql): points: %, with a region: %, states not mapped: %',
    (SELECT count(*) FROM "PickupLocation"),
    (SELECT count(*) FROM "PickupLocation" WHERE "region" IS NOT NULL),
    (SELECT count(*) FROM "AuditLog" WHERE entity = 'PickupMigration');
END $$;
