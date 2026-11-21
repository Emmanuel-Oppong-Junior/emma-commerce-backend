-- Promotions, coupon codes and redemptions, expand + backfill (P2-B.1, ADR-0005 §2 and §5, roadmap step M10).
-- 20261126010000_promotions_contract drops Discount, Coupon and CouponUsage; it ships in the same release.

-- CreateEnum
CREATE TYPE "PromotionScope" AS ENUM ('SKU', 'PRODUCT', 'CATEGORY', 'BRAND', 'CART');

-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENT', 'AMOUNT_OFF', 'FIXED_PRICE');

-- CreateEnum
CREATE TYPE "RedemptionStatus" AS ENUM ('RESERVED', 'RELEASED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "couponCodeId" TEXT;

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "PromotionScope" NOT NULL,
    "type" "PromotionType" NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "minimumSpend" DECIMAL(14,2),
    "minimumQuantity" INTEGER,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "stackingGroup" TEXT NOT NULL DEFAULT 'default',
    "exclusive" BOOLEAN NOT NULL DEFAULT false,
    "requiresCoupon" BOOLEAN NOT NULL DEFAULT false,
    "usageLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "perCustomerLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CouponCode" (
    "id" TEXT NOT NULL,
    "code" VARCHAR(50) NOT NULL,
    "promotionId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "usageLimit" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Redemption" (
    "id" TEXT NOT NULL,
    "promotionId" TEXT NOT NULL,
    "couponCodeId" TEXT,
    "customerId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "RedemptionStatus" NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "Redemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CategoryToPromotion" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CategoryToPromotion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_BrandToPromotion" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BrandToPromotion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_ProductToPromotion" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_ProductToPromotion_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "_PromotionToVariant" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_PromotionToVariant_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE INDEX "Promotion_isActive_startsAt_endsAt_idx" ON "Promotion"("isActive", "startsAt", "endsAt");

-- CreateIndex
CREATE UNIQUE INDEX "CouponCode_code_key" ON "CouponCode"("code");

-- CreateIndex
CREATE INDEX "CouponCode_promotionId_idx" ON "CouponCode"("promotionId");

-- CreateIndex
CREATE INDEX "Redemption_promotionId_customerId_status_idx" ON "Redemption"("promotionId", "customerId", "status");

-- CreateIndex
CREATE INDEX "Redemption_couponCodeId_idx" ON "Redemption"("couponCodeId");

-- CreateIndex
CREATE INDEX "Redemption_customerId_idx" ON "Redemption"("customerId");

-- CreateIndex
CREATE INDEX "Redemption_orderId_idx" ON "Redemption"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Redemption_promotionId_customerId_orderId_key" ON "Redemption"("promotionId", "customerId", "orderId");

-- CreateIndex
CREATE INDEX "_CategoryToPromotion_B_index" ON "_CategoryToPromotion"("B");

-- CreateIndex
CREATE INDEX "_BrandToPromotion_B_index" ON "_BrandToPromotion"("B");

-- CreateIndex
CREATE INDEX "_ProductToPromotion_B_index" ON "_ProductToPromotion"("B");

-- CreateIndex
CREATE INDEX "_PromotionToVariant_B_index" ON "_PromotionToVariant"("B");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponCodeId_fkey" FOREIGN KEY ("couponCodeId") REFERENCES "CouponCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CouponCode" ADD CONSTRAINT "CouponCode_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_promotionId_fkey" FOREIGN KEY ("promotionId") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_couponCodeId_fkey" FOREIGN KEY ("couponCodeId") REFERENCES "CouponCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToPromotion" ADD CONSTRAINT "_CategoryToPromotion_A_fkey" FOREIGN KEY ("A") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CategoryToPromotion" ADD CONSTRAINT "_CategoryToPromotion_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BrandToPromotion" ADD CONSTRAINT "_BrandToPromotion_A_fkey" FOREIGN KEY ("A") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BrandToPromotion" ADD CONSTRAINT "_BrandToPromotion_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductToPromotion" ADD CONSTRAINT "_ProductToPromotion_A_fkey" FOREIGN KEY ("A") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ProductToPromotion" ADD CONSTRAINT "_ProductToPromotion_B_fkey" FOREIGN KEY ("B") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionToVariant" ADD CONSTRAINT "_PromotionToVariant_A_fkey" FOREIGN KEY ("A") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_PromotionToVariant" ADD CONSTRAINT "_PromotionToVariant_B_fkey" FOREIGN KEY ("B") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A percentage is at most 100; a cart has no single unit price to fix; counts and limits are never negative.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_value_valid" CHECK (
  "value" >= 0 AND ("type" <> 'PERCENT' OR "value" <= 100)
);
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_fixed_price_not_cart" CHECK (NOT ("type" = 'FIXED_PRICE' AND "scope" = 'CART'));
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_counts_valid" CHECK (
  "usedCount" >= 0
  AND ("usageLimit" IS NULL OR "usageLimit" >= 0)
  AND ("perCustomerLimit" IS NULL OR "perCustomerLimit" >= 0)
  AND ("minimumSpend" IS NULL OR "minimumSpend" >= 0)
  AND ("minimumQuantity" IS NULL OR "minimumQuantity" >= 1)
);
ALTER TABLE "CouponCode" ADD CONSTRAINT "CouponCode_code_upper_case" CHECK ("code" = upper("code"));
ALTER TABLE "CouponCode" ADD CONSTRAINT "CouponCode_counts_valid" CHECK (
  "usedCount" >= 0 AND ("usageLimit" IS NULL OR "usageLimit" >= 0)
);

-- Backfill, safe to re-run while the old tables exist (20261126010000_promotions_contract refuses to drop them until
-- every row is copied). Ids are kept, so OrderAdjustment.sourceId (a Discount or Coupon id) already names the new
-- promotion and Order.couponId becomes Order.couponCodeId unchanged. Behaviour is kept exactly:
--   * a Discount becomes an automatic promotion (requiresCoupon false), PERCENTAGE -> PERCENT, FLAT -> AMOUNT_OFF,
--     startDate/endDate -> startsAt/endsAt, minimumPurchase -> minimumSpend (checked on the list-price subtotal, as
--     before), all in stacking group "default" so a line still gets only the one that saves the most. A promotion has
--     one kind of target, so a discount on variants, products and categories at once becomes one promotion per kind:
--     the first of SKU, PRODUCT, CATEGORY keeps the discount's id, the others get "<id>_product" / "<id>_category".
--     A discount without targets becomes a PRODUCT promotion without targets (it applied to nothing and still does);
--   * a Coupon becomes a CART promotion with requiresCoupon and one CouponCode, both with the coupon's id:
--     expiresAt -> endsAt (startsAt = the coupon's createdAt), minimumOrderAmount -> minimumSpend (checked on the
--     subtotal after item promotions, as before), usageLimit and usedCount carried over, perCustomerLimit 1 (the old
--     one-use-per-customer unique index). The code is stored upper case, as the coupon service always wrote it;
--   * a percentage above 100 becomes 100 (the engine already capped the saving at the price, so the charge is the
--     same); scripts/reports/promotions-migration-report.sql lists them;
--   * a CouponUsage becomes a RESERVED Redemption with the usage's id (released uses were deleted, never kept).
-- Read the result with scripts/reports/promotions-migration-report.sql.

WITH pieces AS (
  SELECT d.id AS discount_id, t.scope, t.rank
  FROM "Discount" d
  CROSS JOIN LATERAL (
    SELECT 'SKU'::"PromotionScope" AS scope, 1 AS rank WHERE EXISTS (SELECT 1 FROM "Variant" v WHERE v."discountId" = d.id)
    UNION ALL
    SELECT 'PRODUCT', 2 WHERE EXISTS (SELECT 1 FROM "_DiscountToProduct" dp WHERE dp."A" = d.id)
    UNION ALL
    SELECT 'CATEGORY', 3 WHERE EXISTS (SELECT 1 FROM "Category" c WHERE c."discountId" = d.id)
  ) t
  UNION ALL
  SELECT d.id, 'PRODUCT', 2
  FROM "Discount" d
  WHERE NOT EXISTS (SELECT 1 FROM "Variant" v WHERE v."discountId" = d.id)
    AND NOT EXISTS (SELECT 1 FROM "_DiscountToProduct" dp WHERE dp."A" = d.id)
    AND NOT EXISTS (SELECT 1 FROM "Category" c WHERE c."discountId" = d.id)
),
named AS (
  SELECT discount_id, scope,
         CASE WHEN rank = min(rank) OVER (PARTITION BY discount_id) THEN discount_id
              ELSE discount_id || '_' || lower(scope::text) END AS promotion_id
  FROM pieces
)
INSERT INTO "Promotion" ("id", "name", "description", "scope", "type", "value", "minimumSpend", "startsAt", "endsAt",
                         "isActive", "requiresCoupon", "createdAt", "updatedAt")
SELECT n.promotion_id, d.name, d.description, n.scope,
       CASE d.type WHEN 'PERCENTAGE' THEN 'PERCENT'::"PromotionType" ELSE 'AMOUNT_OFF'::"PromotionType" END,
       CASE d.type WHEN 'PERCENTAGE' THEN LEAST(d.value, 100) ELSE d.value END,
       d."minimumPurchase", d."startDate", d."endDate", d."isActive", false, d."createdAt", d."updatedAt"
FROM named n JOIN "Discount" d ON d.id = n.discount_id
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "_PromotionToVariant" ("A", "B")
SELECT p.id, v.id
FROM "Variant" v JOIN "Promotion" p ON p.id = v."discountId" AND p.scope = 'SKU'
ON CONFLICT DO NOTHING;

INSERT INTO "_ProductToPromotion" ("A", "B")
SELECT dp."B", p.id
FROM "_DiscountToProduct" dp
JOIN "Promotion" p ON p.scope = 'PRODUCT' AND (p.id = dp."A" OR p.id = dp."A" || '_product')
ON CONFLICT DO NOTHING;

INSERT INTO "_CategoryToPromotion" ("A", "B")
SELECT c.id, p.id
FROM "Category" c
JOIN "Promotion" p ON p.scope = 'CATEGORY' AND (p.id = c."discountId" OR p.id = c."discountId" || '_category')
ON CONFLICT DO NOTHING;

INSERT INTO "Promotion" ("id", "name", "scope", "type", "value", "minimumSpend", "startsAt", "endsAt", "isActive",
                         "requiresCoupon", "usageLimit", "usedCount", "perCustomerLimit", "createdAt", "updatedAt")
SELECT c.id, 'Coupon ' || upper(c.code), 'CART',
       CASE c."discountType" WHEN 'PERCENTAGE' THEN 'PERCENT'::"PromotionType" ELSE 'AMOUNT_OFF'::"PromotionType" END,
       CASE c."discountType" WHEN 'PERCENTAGE' THEN LEAST(c.value, 100) ELSE c.value END,
       c."minimumOrderAmount", c."createdAt", c."expiresAt", c."isActive", true, c."usageLimit", c."usedCount", 1,
       c."createdAt", c."updatedAt"
FROM "Coupon" c
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "CouponCode" ("id", "code", "promotionId", "isActive", "usedCount", "createdAt", "updatedAt")
SELECT c.id, upper(c.code), c.id, c."isActive", c."usedCount", c."createdAt", c."updatedAt"
FROM "Coupon" c JOIN "Promotion" p ON p.id = c.id
ON CONFLICT DO NOTHING;

INSERT INTO "Redemption" ("id", "promotionId", "couponCodeId", "customerId", "orderId", "status", "createdAt")
SELECT cu.id, p.id, cc.id, cu."userId", cu."orderId", 'RESERVED', cu."createdAt"
FROM "CouponUsage" cu
JOIN "Promotion" p ON p.id = cu."couponId"
JOIN "Order" o ON o.id = cu."orderId"
LEFT JOIN "CouponCode" cc ON cc.id = cu."couponId"
ON CONFLICT DO NOTHING;

UPDATE "Order" o
SET "couponCodeId" = cc.id
FROM "CouponCode" cc
WHERE cc.id = o."couponId" AND o."couponCodeId" IS NULL;

DO $$
DECLARE
  summary text;
BEGIN
  SELECT format('promotions from discounts: %s (discounts: %s), from coupons: %s (coupons: %s), coupon codes: %s, redemptions: %s (coupon usages: %s), orders with a coupon code: %s (with a coupon: %s), percentages capped at 100: %s',
                (SELECT count(*) FROM "Promotion" p WHERE NOT p."requiresCoupon"
                   AND EXISTS (SELECT 1 FROM "Discount" d WHERE p.id IN (d.id, d.id || '_product', d.id || '_category'))),
                (SELECT count(*) FROM "Discount"),
                (SELECT count(*) FROM "Promotion" p WHERE EXISTS (SELECT 1 FROM "Coupon" c WHERE c.id = p.id)),
                (SELECT count(*) FROM "Coupon"),
                (SELECT count(*) FROM "CouponCode"),
                (SELECT count(*) FROM "Redemption"),
                (SELECT count(*) FROM "CouponUsage"),
                (SELECT count(*) FROM "Order" WHERE "couponCodeId" IS NOT NULL),
                (SELECT count(*) FROM "Order" WHERE "couponId" IS NOT NULL),
                (SELECT count(*) FROM "Discount" WHERE type = 'PERCENTAGE' AND value > 100)
                  + (SELECT count(*) FROM "Coupon" WHERE "discountType" = 'PERCENTAGE' AND value > 100))
  INTO summary;
  RAISE NOTICE 'Promotions migration (scripts/reports/promotions-migration-report.sql): %', summary;
END $$;
