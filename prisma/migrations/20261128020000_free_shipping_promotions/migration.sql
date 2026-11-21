-- Free-shipping promotions (P2-B.6). Expand only: a new promotion type, its shipping-zone join table and an
-- OrderAdjustment target. Every existing adjustment reduced merchandise, so the MERCHANDISE default is right for all of
-- them: nothing to backfill.

-- CreateEnum
CREATE TYPE "OrderAdjustmentTarget" AS ENUM ('MERCHANDISE', 'SHIPPING');

-- AlterEnum
ALTER TYPE "PromotionType" ADD VALUE 'FREE_SHIPPING';

-- AlterTable
ALTER TABLE "OrderAdjustment" ADD COLUMN     "target" "OrderAdjustmentTarget" NOT NULL DEFAULT 'MERCHANDISE';

-- CreateTable
CREATE TABLE "_PromotionToShippingZone" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionToShippingZone_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "_PromotionToShippingZone_B_index" ON "_PromotionToShippingZone"("B");

-- AddForeignKey
ALTER TABLE "_PromotionToShippingZone" ADD CONSTRAINT "_PromotionToShippingZone_A_fkey" FOREIGN KEY ("A") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionToShippingZone" ADD CONSTRAINT "_PromotionToShippingZone_B_fkey" FOREIGN KEY ("B") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The new enum value cannot be used as an enum literal in the transaction that adds it, so the checks compare text.
-- value: TIERED has none; FREE_SHIPPING has none (waive the fee) or an amount off the fee.
ALTER TABLE "Promotion" DROP CONSTRAINT "Promotion_value_valid";
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_value_valid" CHECK (
  ("value" IS NULL OR ("value" >= 0 AND ("type"::text NOT IN ('PERCENT', 'BXGY') OR "value" <= 100)))
  AND ("value" IS NOT NULL OR "type"::text IN ('TIERED', 'FREE_SHIPPING'))
  AND NOT ("type"::text = 'TIERED' AND "value" IS NOT NULL)
);
-- FREE_SHIPPING reduces the delivery fee of the whole order: CART scope, no unit cap.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_free_shipping_valid" CHECK (
  "type"::text <> 'FREE_SHIPPING' OR ("scope" = 'CART' AND "unitCap" IS NULL)
);
-- A shipping adjustment is never on a line.
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_shipping_not_on_line" CHECK (
  "target" = 'MERCHANDISE' OR "orderItemId" IS NULL
);
