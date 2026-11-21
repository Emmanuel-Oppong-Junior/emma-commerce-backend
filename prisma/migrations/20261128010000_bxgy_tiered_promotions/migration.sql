-- BXGY, tiered/volume and spend-X-save-Y promotions (P2-B.5). Expand only: new enum values, nullable columns, a tier
-- table and the BXGY reward-target join tables. Existing rows keep their value (only TIERED has none); nothing to
-- backfill.

-- AlterEnum
ALTER TYPE "PromotionType" ADD VALUE 'BXGY';
ALTER TYPE "PromotionType" ADD VALUE 'TIERED';

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "buyQuantity" INTEGER,
ADD COLUMN     "getQuantity" INTEGER,
ADD COLUMN     "maxApplications" INTEGER,
ADD COLUMN     "tierValueType" "PromotionType",
ALTER COLUMN "value" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PromotionTier" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "minimumQuantity" INTEGER,
    "minimumSpend" DECIMAL(14,2),
    "value" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PromotionTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_PromotionRewardCategories" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionRewardCategories_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionRewardBrands" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionRewardBrands_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionRewardProducts" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionRewardProducts_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionRewardVariants" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionRewardVariants_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "PromotionTier_promotionId_idx" ON "PromotionTier"("promotionId");

-- CreateIndex
CREATE INDEX "_PromotionRewardCategories_B_index" ON "_PromotionRewardCategories"("B");

-- CreateIndex
CREATE INDEX "_PromotionRewardBrands_B_index" ON "_PromotionRewardBrands"("B");

-- CreateIndex
CREATE INDEX "_PromotionRewardProducts_B_index" ON "_PromotionRewardProducts"("B");

-- CreateIndex
CREATE INDEX "_PromotionRewardVariants_B_index" ON "_PromotionRewardVariants"("B");

-- AddForeignKey
ALTER TABLE "PromotionTier" ADD CONSTRAINT "PromotionTier_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardCategories" ADD CONSTRAINT "_PromotionRewardCategories_A_fkey" FOREIGN KEY ("A") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardCategories" ADD CONSTRAINT "_PromotionRewardCategories_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardBrands" ADD CONSTRAINT "_PromotionRewardBrands_A_fkey" FOREIGN KEY ("A") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardBrands" ADD CONSTRAINT "_PromotionRewardBrands_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardProducts" ADD CONSTRAINT "_PromotionRewardProducts_A_fkey" FOREIGN KEY ("A") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardProducts" ADD CONSTRAINT "_PromotionRewardProducts_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardVariants" ADD CONSTRAINT "_PromotionRewardVariants_A_fkey" FOREIGN KEY ("A") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionRewardVariants" ADD CONSTRAINT "_PromotionRewardVariants_B_fkey" FOREIGN KEY ("B") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The new enum values cannot be used as enum literals in the transaction that adds them, so these checks compare text.
-- value: a percentage (PERCENT, BXGY's reward discount) is at most 100; only TIERED has none (its tiers carry them).
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_value_valid";
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_value_valid" CHECK (
  ("value" IS NULL OR ("value" >= 0 AND ("type"::text NOT IN ('PERCENT', 'BXGY') OR "value" <= 100)))
  AND (("value" IS NULL) = ("type"::text = 'TIERED'))
);
-- BXGY needs its buy and get quantities and an item scope; the BXGY fields belong to BXGY only.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_bxgy_valid" CHECK (
  (("type"::text = 'BXGY') = ("buyQuantity" IS NOT NULL AND "getQuantity" IS NOT NULL))
  AND ("buyQuantity" IS NULL OR "buyQuantity" >= 1)
  AND ("getQuantity" IS NULL OR "getQuantity" >= 1)
  AND ("maxApplications" IS NULL OR ("maxApplications" >= 1 AND "type"::text = 'BXGY'))
  AND NOT ("type"::text = 'BXGY' AND "scope" = 'CART')
);
-- TIERED says how its tiers reduce the price, as one of the simple types (no fixed price for a cart).
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_tiers_valid" CHECK (
  (("type"::text = 'TIERED') = ("tierValueType" IS NOT NULL))
  AND ("tierValueType" IS NULL OR "tierValueType"::text IN ('PERCENT', 'AMOUNT_OFF', 'FIXED_PRICE'))
  AND NOT ("tierValueType"::text = 'FIXED_PRICE' AND "scope" = 'CART')
);
ALTER TABLE "PromotionTier" ADD CONSTRAINT "PromotionTier_valid" CHECK (
  num_nonnulls("minimumQuantity", "minimumSpend") = 1
  AND ("minimumQuantity" IS NULL OR "minimumQuantity" >= 1)
  AND ("minimumSpend" IS NULL OR "minimumSpend" >= 0)
  AND "value" >= 0
);
