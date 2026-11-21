-- Price history (P2-H.1, ADR-0005 §6): an append-only PriceChange row for every change to Variant.price or
-- Variant.basePrice, written by the application in the same transaction as the change.

-- CreateEnum
CREATE TYPE "PriceChangeField" AS ENUM ('PRICE', 'BASE_PRICE');

-- CreateEnum
CREATE TYPE "PriceChangeSource" AS ENUM ('ADMIN_EDIT', 'VARIANT_CREATED', 'TAX_RATE_CHANGE', 'MIGRATION');

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "field" "PriceChangeField" NOT NULL,
    "oldValue" DECIMAL(14,2),
    "newValue" DECIMAL(14,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "source" "PriceChangeSource" NOT NULL,
    "reason" TEXT,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceChange_variantId_createdAt_idx" ON "PriceChange"("variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "PriceChange" ADD CONSTRAINT "PriceChange_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The history is append-only. Deleting a variant (or its product) still removes its rows: those deletes run inside the
-- foreign-key cascade trigger, so they are nested one trigger level deeper than a direct DELETE.
CREATE FUNCTION "price_change_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'PriceChange is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "PriceChange_append_only" BEFORE UPDATE OR DELETE ON "PriceChange"
  FOR EACH ROW EXECUTE FUNCTION "price_change_append_only"();

-- Backfill, safe to re-run: one MIGRATION row per priced field of every variant that has no history for it yet, so
-- each variant's history starts from the price it had when this shipped. A variant without a price gets no row for it.
INSERT INTO "PriceChange" ("id", "variantId", "field", "oldValue", "newValue", "currency", "source")
SELECT 'price_migration_' || lower(f.field::text) || '_' || v.id, v.id, f.field, NULL, f.value,
       (SELECT s."currency" FROM "Store" s WHERE s."singleton"), 'MIGRATION'
FROM "Variant" v
CROSS JOIN LATERAL (
  VALUES ('PRICE'::"PriceChangeField", v."price"), ('BASE_PRICE'::"PriceChangeField", v."basePrice")
) AS f(field, value)
WHERE f.value IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "PriceChange" pc WHERE pc."variantId" = v.id AND pc."field" = f.field)
ON CONFLICT ("id") DO NOTHING;
