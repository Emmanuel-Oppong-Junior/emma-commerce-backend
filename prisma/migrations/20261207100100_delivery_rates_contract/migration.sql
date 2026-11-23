-- Delivery zones and rate rules, contract phase (P5-A.1). Zones match addresses through ZoneArea and price delivery
-- through RateRule; 20261207100000_delivery_rates backfilled them from the city lists and flat fees dropped here.

-- Fail fast instead of dropping what the backfill has not copied: rerun the "-- Backfill" section of
-- 20261207100000_delivery_rates first.
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT (SELECT count(*) FROM "ShippingZone" z
          WHERE NOT EXISTS (SELECT 1 FROM "RateRule" r WHERE r."zoneId" = z.id AND r."serviceLevel" = 'STANDARD'))
       + (SELECT count(*) FROM "ShippingZone" z CROSS JOIN LATERAL unnest(z."cities") AS c(city)
          WHERE btrim(regexp_replace(lower(translate(c.city, 'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ''’`', 'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC')),
                                     '[^a-z0-9]+', ' ', 'g')) <> ''
            AND NOT EXISTS (
              SELECT 1 FROM "ZoneArea" a
              WHERE a."matchKey" = 'TOWN:' || btrim(regexp_replace(
                lower(translate(c.city, 'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ''’`', 'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC')), '[^a-z0-9]+', ' ', 'g'))))
  INTO behind;
  IF behind > 0 THEN
    RAISE EXCEPTION '% zone fee(s) or city(ies) are not migrated yet; rerun the backfill of 20261207100000_delivery_rates first', behind;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "ShippingZone" DROP COLUMN "cities",
DROP COLUMN "fee";
