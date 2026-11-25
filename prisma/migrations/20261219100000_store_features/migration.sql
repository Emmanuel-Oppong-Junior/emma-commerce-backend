-- P8-F: store-level feature switches. One StoreFeature row per switched feature (no row = the default in
-- src/store-features/store-feature-registry.ts, on for every feature). The loyalty on/off setting moves here from
-- Store."loyaltyEnabled" so there is one source of truth; cash on delivery stays in Store."cashOnDeliveryEnabled" and a
-- CHECK keeps it out of this table. The new store.features.manage permission is recorded on the Owner role only.

-- CreateEnum
CREATE TYPE "StoreFeatureKey" AS ENUM ('GUEST_CHECKOUT', 'LOYALTY', 'REFERRALS', 'REVIEWS', 'PRODUCT_QA', 'RECENTLY_VIEWED', 'RETURNS', 'ABANDONED_CART_REMINDERS', 'SAVED_FOR_LATER', 'WISHLIST', 'CASH_ON_DELIVERY');

-- CreateTable
CREATE TABLE "StoreFeature" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "key" "StoreFeatureKey" NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreFeature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreFeature_storeId_key_key" ON "StoreFeature"("storeId", "key");

-- AddForeignKey
ALTER TABLE "StoreFeature" ADD CONSTRAINT "StoreFeature_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StoreFeature" ADD CONSTRAINT "StoreFeature_not_cash_on_delivery" CHECK ("key" <> 'CASH_ON_DELIVERY');

-- Move the loyalty switch, keeping its value. Safe to re-run: skipped once the column is gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'Store' AND column_name = 'loyaltyEnabled'
  ) THEN
    INSERT INTO "StoreFeature" ("id", "storeId", "key", "enabled", "updatedAt")
    SELECT 'store_feature_loyalty_' || gen_random_uuid(), "id", 'LOYALTY', "loyaltyEnabled", CURRENT_TIMESTAMP
    FROM "Store"
    ON CONFLICT ("storeId", "key") DO NOTHING;
    ALTER TABLE "Store" DROP COLUMN "loyaltyEnabled";
  END IF;
END $$;

-- Who may switch features: store.features.manage, on the Owner role only (the Owner holds every permission anyway).
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'store.features.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'OWNER'
  AND NOT ('store.features.manage' = ANY ("permissions"));
