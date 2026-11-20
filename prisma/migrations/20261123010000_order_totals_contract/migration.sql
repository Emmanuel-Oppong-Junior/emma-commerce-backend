-- Order totals, contract phase (P1-O.1). Orders now store currency, pricingVersion and the subtotal / discountTotal /
-- taxTotal / shippingTotal / grandTotal breakdown; lines store their snapshot. The old money columns are dropped.
-- 20261123000000_order_totals backfilled them; it ships in the same release.

-- Fail fast instead of dropping money the backfill has not copied: rerun the "-- Backfill" section of
-- 20261123000000_order_totals, then this migration.
DO $$
DECLARE
  behind bigint;
BEGIN
  SELECT (SELECT count(*) FROM "Order"
          WHERE "pricingVersion" IS NULL OR "currency" IS NULL OR "grandTotal" IS NULL)
       + (SELECT count(*) FROM "OrderItem"
          WHERE "productName" IS NULL OR "unitListPrice" IS NULL OR "unitDiscount" IS NULL OR "lineTotal" IS NULL)
  INTO behind;
  IF behind > 0 THEN
    RAISE EXCEPTION '% order(s) or order line(s) have no totals yet; rerun the backfill of 20261123000000_order_totals first', behind;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_discountId_fkey";

-- DropIndex
DROP INDEX "OrderItem_discountId_idx";

-- AlterTable
ALTER TABLE "Order" DROP COLUMN "couponDiscount",
DROP COLUMN "shippingFee",
DROP COLUMN "totalAmount",
DROP COLUMN "totalWithOutDiscount",
ALTER COLUMN "currency" SET NOT NULL,
ALTER COLUMN "pricingVersion" SET NOT NULL,
ALTER COLUMN "grandTotal" SET NOT NULL;

-- AlterTable
ALTER TABLE "OrderItem" DROP COLUMN "discountAmount",
DROP COLUMN "discountId",
DROP COLUMN "originalPrice",
DROP COLUMN "priceAtOrder",
ALTER COLUMN "productName" SET NOT NULL,
ALTER COLUMN "unitListPrice" SET NOT NULL,
ALTER COLUMN "unitDiscount" SET NOT NULL,
ALTER COLUMN "lineTotal" SET NOT NULL;

-- A priced order (pricingVersion 1 and later) always has its full breakdown; only legacy orders may lack parts of it.
ALTER TABLE "Order" ADD CONSTRAINT "Order_priced_totals_complete" CHECK (
  "pricingVersion" = 0
  OR ("subtotal" IS NOT NULL AND "discountTotal" IS NOT NULL AND "taxTotal" IS NOT NULL AND "shippingTotal" IS NOT NULL)
);
ALTER TABLE "Order" ADD CONSTRAINT "Order_grand_total_not_negative" CHECK ("grandTotal" >= 0);
