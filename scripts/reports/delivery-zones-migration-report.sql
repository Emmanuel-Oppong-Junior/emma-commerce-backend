-- Report of the delivery zones migration, P5-A.1 (prisma/migrations/20261207100000_delivery_rates and its contract).
-- Read-only and safe to re-run. It reads the rows the migration wrote to "AuditLog" (entity 'ZoneMigration'): zone
-- ids and city names only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/delivery-zones-migration-report.sql
--
-- Actions:
--   CITY_BLANK_DROPPED       a city that normalised to nothing; dropped
--   CITY_IN_OTHER_ZONE       a city also listed by an older zone (keptInZone), which keeps it; add an area to this
--                            zone if it should win somewhere
--   CITY_UNUSUAL_CHARACTERS  a city with characters the SQL normalisation does not map; check that its town matches
--                            how customers spell it (shipping-zones/zone-matching.ts normalisePlaceName)

SELECT action, count(*) AS cities
FROM "AuditLog"
WHERE entity = 'ZoneMigration'
GROUP BY action
ORDER BY action;

SELECT action, "entityId" AS "zoneId", details->>'city' AS city, details->>'town' AS town,
       details->>'keptInZone' AS "keptInZone"
FROM "AuditLog"
WHERE entity = 'ZoneMigration'
ORDER BY action, "entityId", details->>'city';

-- Zones without any area (they match no address) and active zones without an active rate rule (delivery refused).
SELECT z.id AS "zoneId", z.name, z."isActive",
       (SELECT count(*) FROM "ZoneArea" a WHERE a."zoneId" = z.id) AS areas,
       (SELECT count(*) FROM "RateRule" r WHERE r."zoneId" = z.id AND r."isActive") AS "activeRules"
FROM "ShippingZone" z
WHERE NOT EXISTS (SELECT 1 FROM "ZoneArea" a WHERE a."zoneId" = z.id)
   OR (z."isActive" AND NOT EXISTS (SELECT 1 FROM "RateRule" r WHERE r."zoneId" = z.id AND r."isActive"))
ORDER BY z.name;
