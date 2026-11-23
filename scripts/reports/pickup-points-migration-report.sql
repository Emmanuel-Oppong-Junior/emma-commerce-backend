-- Report of the pickup points migration, P5-E.1 (prisma/migrations/20261207120000_pickup_points and its contract).
-- Read-only and safe to re-run: pickup point ids and the old state text only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/pickup-points-migration-report.sql

-- Pickup points whose free-text state matched no region: set their region with updatePickupLocation.
SELECT a."entityId" AS "pickupLocationId", p.name, a.details->>'state' AS state, p."region"
FROM "AuditLog" a
LEFT JOIN "PickupLocation" p ON p.id = a."entityId"
WHERE a.entity = 'PickupMigration'
ORDER BY p.name;

-- Active pickup points customers cannot plan a visit to yet: no opening hours or no contact phone.
SELECT p.id AS "pickupLocationId", p.name,
       NOT EXISTS (SELECT 1 FROM "PickupOpeningHours" h WHERE h."pickupLocationId" = p.id) AS "noOpeningHours",
       p."contactPhone" IS NULL AS "noContactPhone"
FROM "PickupLocation" p
WHERE p."isActive"
  AND (p."contactPhone" IS NULL OR NOT EXISTS (SELECT 1 FROM "PickupOpeningHours" h WHERE h."pickupLocationId" = p.id))
ORDER BY p.name;
