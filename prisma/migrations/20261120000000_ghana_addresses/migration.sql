-- Ghana addresses (P1-G.1, ADR-01): region enum replaces free-text state; recipient, phone, area, landmark,
-- GhanaPostGPS and coordinates are added; zipCode becomes optional.
-- "state" is dropped here without an expand/contract release: nothing is live yet (decision of 2026-11-20), so
-- this backfill is the only place state is mapped to region. Every statement is safe to re-run.

DO $$
BEGIN
  CREATE TYPE "GhanaRegion" AS ENUM ('AHAFO', 'ASHANTI', 'BONO', 'BONO_EAST', 'CENTRAL', 'EASTERN', 'GREATER_ACCRA', 'NORTH_EAST', 'NORTHERN', 'OTI', 'SAVANNAH', 'UPPER_EAST', 'UPPER_WEST', 'VOLTA', 'WESTERN', 'WESTERN_NORTH');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "Address"
  ADD COLUMN IF NOT EXISTS "recipientName" TEXT,
  ADD COLUMN IF NOT EXISTS "phone" TEXT,
  ADD COLUMN IF NOT EXISTS "region" "GhanaRegion",
  ADD COLUMN IF NOT EXISTS "area" TEXT,
  ADD COLUMN IF NOT EXISTS "landmark" TEXT,
  ADD COLUMN IF NOT EXISTS "ghanaPostGps" TEXT,
  ADD COLUMN IF NOT EXISTS "latitude" DECIMAL(9,6),
  ADD COLUMN IF NOT EXISTS "longitude" DECIMAL(9,6),
  ALTER COLUMN "zipCode" DROP NOT NULL;

-- "Greater Accra", "greater-accra region", "GREATER_ACCRA" and "Ashanti Region" all map; values that are not one of
-- the 16 region names once case, separators and a trailing "Region" are ignored ("Brong Ahafo", "Accra") stay NULL
-- for the customer to complete at checkout.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'Address' AND column_name = 'state'
  ) THEN
    UPDATE "Address" AS a
    SET "region" = mapped.key::"GhanaRegion"
    FROM (
      SELECT id,
             replace(
               regexp_replace(
                 btrim(regexp_replace(regexp_replace(upper("state"), '[-_]', ' ', 'g'), '\s+', ' ', 'g')),
                 ' REGION$', ''),
               ' ', '_') AS key
      FROM "Address"
    ) AS mapped
    WHERE a.id = mapped.id
      AND a."region" IS NULL
      AND mapped.key IN (SELECT unnest(enum_range(NULL::"GhanaRegion"))::text);
  END IF;
END $$;

ALTER TABLE "Address" DROP COLUMN IF EXISTS "state";

-- Ghana-only store: country is the ISO code "GH". Other values are left for a person to look at.
UPDATE "Address" SET "country" = 'GH' WHERE lower(btrim("country")) IN ('ghana', 'gh') AND "country" <> 'GH';
