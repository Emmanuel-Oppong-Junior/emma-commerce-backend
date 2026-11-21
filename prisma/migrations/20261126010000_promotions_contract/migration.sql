-- Promotions, contract phase (P2-B.1). Discounts and coupons are promotions and coupon codes now; the old tables,
-- the variant and category discount links, the cart's discount columns and Order.couponId are dropped.
-- 20261126000000_promotions backfilled them; it ships in the same release.

-- Fail fast instead of dropping what the backfill has not copied: rerun the "-- Backfill" section of
-- 20261126000000_promotions (and resolve what scripts/reports/promotions-migration-report.sql lists), then this one.
-- Coupon uses of orders that no longer exist cannot become redemptions and are dropped (the report lists them).
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT (SELECT count(*) FROM "Discount" d WHERE NOT EXISTS (SELECT 1 FROM "Promotion" p WHERE p.id = d.id))
       + (SELECT count(*) FROM "Coupon" c WHERE NOT EXISTS (SELECT 1 FROM "CouponCode" cc WHERE cc.id = c.id))
       + (SELECT count(*) FROM "CouponUsage" cu
          WHERE EXISTS (SELECT 1 FROM "Order" o WHERE o.id = cu."orderId")
            AND NOT EXISTS (SELECT 1 FROM "Redemption" r WHERE r.id = cu.id))
       + (SELECT count(*) FROM "Order" o WHERE o."couponId" IS NOT NULL AND o."couponCodeId" IS NULL)
  INTO behind;
  IF behind > 0 THEN
    RAISE EXCEPTION '% discount(s), coupon(s), coupon use(s) or order coupon(s) are not migrated yet; rerun the backfill of 20261126000000_promotions first', behind;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "CartItem" DROP CONSTRAINT "CartItem_discountId_fkey";

-- DropForeignKey
ALTER TABLE "Category" DROP CONSTRAINT "Category_discountId_fkey";

-- DropForeignKey
ALTER TABLE "CouponUsage" DROP CONSTRAINT "CouponUsage_couponId_fkey";

-- DropForeignKey
ALTER TABLE "CouponUsage" DROP CONSTRAINT "CouponUsage_userId_fkey";

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_couponId_fkey";

-- DropForeignKey
ALTER TABLE "Variant" DROP CONSTRAINT "Variant_discountId_fkey";

-- DropForeignKey
ALTER TABLE "_DiscountToProduct" DROP CONSTRAINT "_DiscountToProduct_A_fkey";

-- DropForeignKey
ALTER TABLE "_DiscountToProduct" DROP CONSTRAINT "_DiscountToProduct_B_fkey";

-- DropIndex
DROP INDEX "CartItem_discountId_idx";

-- DropIndex
DROP INDEX "Category_discountId_idx";

-- DropIndex
DROP INDEX "Variant_discountId_idx";

-- AlterTable
ALTER TABLE "CartItem" DROP COLUMN "discountId",
DROP COLUMN "discountedPrice";

-- AlterTable
ALTER TABLE "Category" DROP COLUMN "discountId";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "couponId";

-- AlterTable
ALTER TABLE "Variant" DROP COLUMN "discountId";

-- DropTable
DROP TABLE "Coupon";

-- DropTable
DROP TABLE "CouponUsage";

-- DropTable
DROP TABLE "Discount";

-- DropTable
DROP TABLE "_DiscountToProduct";

-- DropEnum
DROP TYPE "DiscountType";
