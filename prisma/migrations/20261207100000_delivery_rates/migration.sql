-- Delivery zones and rate rules, expand + backfill (P5-A.1, closes SHZ-01/02/04/05/06/08 as far as in scope).
-- A zone now lists regions, towns and areas (ZoneArea) instead of cities, and prices delivery per service level
-- (RateRule, optional RateWeightBand). 20261207100100_delivery_rates_contract drops ShippingZone.cities and .fee; it
-- ships in the same release.

-- CreateEnum
CREATE TYPE "ZoneAreaLevel" AS ENUM ('REGION', 'TOWN', 'AREA');

-- CreateEnum
CREATE TYPE "DeliveryServiceLevel" AS ENUM ('STANDARD', 'EXPRESS');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "rateRuleId" TEXT,
ADD COLUMN     "serviceLevel" "DeliveryServiceLevel",
ADD COLUMN     "shippingFee" DECIMAL(14,2),
ADD COLUMN     "shippingZoneId" TEXT,
ADD COLUMN     "shippingZoneName" TEXT;

-- CreateTable
CREATE TABLE "ZoneArea" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "level" "ZoneAreaLevel" NOT NULL,
    "region" "GhanaRegion",
    "town" TEXT,
    "area" TEXT,
    "matchKey" TEXT NOT NULL,

    CONSTRAINT "ZoneArea_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateRule" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "serviceLevel" "DeliveryServiceLevel" NOT NULL,
    "baseFee" DECIMAL(14,2) NOT NULL,
    "freeAbove" DECIMAL(14,2),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateWeightBand" (
    "id" TEXT NOT NULL,
    "rateRuleId" TEXT NOT NULL,
    "fromGrams" INTEGER NOT NULL,
    "fee" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "RateWeightBand_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ZoneArea_matchKey_key" ON "ZoneArea"("matchKey");

-- CreateIndex
CREATE INDEX "ZoneArea_zoneId_idx" ON "ZoneArea"("zoneId");

-- CreateIndex
CREATE INDEX "RateRule_zoneId_idx" ON "RateRule"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "RateRule_one_active_per_zone_level" ON "RateRule"("zoneId", "serviceLevel") WHERE ("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "RateWeightBand_rateRuleId_fromGrams_key" ON "RateWeightBand"("rateRuleId", "fromGrams");

-- AddForeignKey
ALTER TABLE "ZoneArea" ADD CONSTRAINT "ZoneArea_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateRule" ADD CONSTRAINT "RateRule_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateWeightBand" ADD CONSTRAINT "RateWeightBand_rateRuleId_fkey" FOREIGN KEY ("rateRuleId") REFERENCES "RateRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A zone area is exactly one shape: a region, a town, or an area within a town; matchKey is its canonical key.
ALTER TABLE "ZoneArea" ADD CONSTRAINT "ZoneArea_shape_check" CHECK (
  ("level" = 'REGION' AND "region" IS NOT NULL AND "town" IS NULL AND "area" IS NULL
     AND "matchKey" = 'REGION:' || "region"::text)
  OR ("level" = 'TOWN' AND "region" IS NULL AND "town" <> '' AND "area" IS NULL AND "matchKey" = 'TOWN:' || "town")
  OR ("level" = 'AREA' AND "region" IS NULL AND "town" <> '' AND "area" <> ''
     AND "matchKey" = 'AREA:' || "town" || '|' || "area")
);

ALTER TABLE "RateRule" ADD CONSTRAINT "RateRule_fees_check"
  CHECK ("baseFee" >= 0 AND ("freeAbove" IS NULL OR "freeAbove" >= 0));
ALTER TABLE "RateWeightBand" ADD CONSTRAINT "RateWeightBand_values_check" CHECK ("fromGrams" > 0 AND "fee" >= 0);

-- Backfill, safe to re-run while ShippingZone.cities and .fee exist (the contract refuses to drop them until every
-- zone has its rule and every non-blank city its town). Each city becomes a TOWN entry, normalised like
-- shipping-zones/zone-matching.ts normalisePlaceName (lower case, common accents and apostrophes dropped, any other
-- run of non-alphanumerics one space, trimmed). A city listed by several zones goes to the oldest; blanks are dropped.
-- Each zone's fee becomes its active STANDARD rule. What could not be kept as it was is written to "AuditLog" (entity
-- 'ZoneMigration', no personal data); read it with scripts/reports/delivery-zones-migration-report.sql.
CREATE TEMP TABLE zone_cities ON COMMIT DROP AS
SELECT z.id AS "zoneId", z."createdAt", c.city AS raw,
       btrim(regexp_replace(
         lower(translate(c.city, 'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ''’`', 'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC')),
         '[^a-z0-9]+', ' ', 'g')) AS town
FROM "ShippingZone" z
CROSS JOIN LATERAL unnest(z."cities") AS c(city);

INSERT INTO "ZoneArea" ("id", "zoneId", "level", "town", "matchKey")
SELECT DISTINCT ON (town) 'zone_area_' || md5('TOWN:' || town), "zoneId", 'TOWN', town, 'TOWN:' || town
FROM zone_cities
WHERE town <> ''
ORDER BY town, "createdAt", "zoneId"
ON CONFLICT DO NOTHING;

INSERT INTO "RateRule" ("id", "zoneId", "serviceLevel", "baseFee", "isActive", "updatedAt")
SELECT z.id || '_standard', z.id, 'STANDARD', z."fee", true, now()
FROM "ShippingZone" z
ON CONFLICT DO NOTHING;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'zone_migration_' || md5(c."zoneId" || '|' || c.raw), 'ZoneMigration', c."zoneId",
       CASE WHEN c.town = '' THEN 'CITY_BLANK_DROPPED' ELSE 'CITY_IN_OTHER_ZONE' END,
       jsonb_build_object('city', c.raw, 'town', c.town, 'keptInZone', a."zoneId")
FROM zone_cities c
LEFT JOIN "ZoneArea" a ON a."matchKey" = 'TOWN:' || c.town
WHERE c.town = '' OR a."zoneId" IS DISTINCT FROM c."zoneId"
ON CONFLICT DO NOTHING;

-- Characters the SQL normalisation does not map (other than plain letters, digits, spaces and punctuation): the town
-- may be spelt differently from what customers' addresses normalise to. Check these by hand.
INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'zone_migration_chars_' || md5(c."zoneId" || '|' || c.raw), 'ZoneMigration', c."zoneId", 'CITY_UNUSUAL_CHARACTERS',
       jsonb_build_object('city', c.raw, 'town', c.town)
FROM zone_cities c
WHERE c.raw ~ '[^ -~]' AND c.raw !~ '^[ -~àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ’]*$'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  RAISE NOTICE 'Delivery zones migration (scripts/reports/delivery-zones-migration-report.sql): zones: %, town entries: %, rate rules: %, cities not kept as they were: %',
    (SELECT count(*) FROM "ShippingZone"),
    (SELECT count(*) FROM "ZoneArea"),
    (SELECT count(*) FROM "RateRule"),
    (SELECT count(*) FROM "AuditLog" WHERE entity = 'ZoneMigration');
END $$;
