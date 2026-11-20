-- Order totals, line snapshots, adjustments and tax lines, expand + backfill (P1-O.1, ADR-0006 snapshot, ADR-0004).
-- 20261123010000_order_totals_contract makes the new columns required and drops the old ones; it ships in the same
-- release. Order.subtotal and Order.discountTotal keep their names with a new meaning: subtotal is now before any
-- discount and discountTotal covers product discounts and the coupon.

-- CreateEnum
CREATE TYPE "OrderAdjustmentType" AS ENUM ('DISCOUNT', 'COUPON');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "currency" "Currency",
ADD COLUMN "pricingVersion" INTEGER,
ADD COLUMN "taxTotal" DECIMAL(14,2),
ADD COLUMN "shippingTotal" DECIMAL(14,2),
ADD COLUMN "grandTotal" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN "productName" TEXT,
ADD COLUMN "unitListPrice" DECIMAL(14,2),
ADD COLUMN "unitDiscount" DECIMAL(14,2),
ADD COLUMN "unitNet" DECIMAL(14,2),
ADD COLUMN "unitTax" DECIMAL(14,2),
ADD COLUMN "lineTotal" DECIMAL(14,2);

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN "taxAmount" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "OrderAdjustment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "orderItemId" TEXT,
    "type" "OrderAdjustmentType" NOT NULL,
    "sourceId" TEXT,
    "code" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineTax" (
    "id" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "taxId" TEXT,
    "name" TEXT NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderLineTax_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAdjustment_orderId_idx" ON "OrderAdjustment"("orderId");

-- CreateIndex
CREATE INDEX "OrderAdjustment_orderItemId_idx" ON "OrderAdjustment"("orderItemId");

-- CreateIndex
CREATE INDEX "OrderLineTax_orderItemId_idx" ON "OrderLineTax"("orderItemId");

-- AddForeignKey
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineTax" ADD CONSTRAINT "OrderLineTax_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Discounts and coupons only ever reduce an order; tax lines are never negative.
ALTER TABLE "OrderAdjustment" ADD CONSTRAINT "OrderAdjustment_reduction_not_positive" CHECK ("amount" <= 0);
ALTER TABLE "OrderLineTax" ADD CONSTRAINT "OrderLineTax_amounts_not_negative" CHECK ("amount" >= 0 AND "base" >= 0 AND "rate" >= 0);

-- Backfill, safe to re-run while the old columns exist (20261123010000_order_totals_contract refuses to drop them
-- until every order is backfilled). It touches only orders without pricingVersion or with pricingVersion 0, never an
-- order createOrder has snapshotted (pricingVersion 1), and copies money only from what each order stored. Nothing is
-- guessed: no tax lines are invented and taxTotal, unitNet and unitTax stay null (the tax in an old order is unknown).
--   * lines: productName <- the product's current name (not stored before), unitListPrice <- originalPrice,
--     unitDiscount <- originalPrice - priceAtOrder, lineTotal <- priceAtOrder x quantity;
--   * a DISCOUNT adjustment ("legacy_discount_<orderItemId>") per discounted line, -unitDiscount x quantity;
--   * a COUPON adjustment ("legacy_coupon_<orderId>") for a stored couponDiscount;
--   * orders: pricingVersion 0, currency <- the store currency, grandTotal <- totalAmount, shippingTotal <- shippingFee,
--     subtotal <- sum of unitListPrice x quantity, discountTotal <- line discounts + couponDiscount (null when the
--     order has a coupon but no stored couponDiscount).
-- Read the result with scripts/reports/order-totals-migration-report.sql.

UPDATE "OrderItem" oi
SET "productName" = p.name,
    "unitListPrice" = oi."originalPrice",
    "unitDiscount" = oi."originalPrice" - oi."priceAtOrder",
    "lineTotal" = oi."priceAtOrder" * oi.quantity
FROM "Product" p, "Order" o
WHERE p.id = oi."productId" AND o.id = oi."orderId" AND COALESCE(o."pricingVersion", 0) = 0;

INSERT INTO "OrderAdjustment" ("id", "orderId", "orderItemId", "type", "sourceId", "amount", "createdAt")
SELECT 'legacy_discount_' || oi.id, oi."orderId", oi.id, 'DISCOUNT', oi."discountId",
       -((oi."originalPrice" - oi."priceAtOrder") * oi.quantity), oi."createdAt"
FROM "OrderItem" oi JOIN "Order" o ON o.id = oi."orderId"
WHERE COALESCE(o."pricingVersion", 0) = 0 AND oi."originalPrice" > oi."priceAtOrder"
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "OrderAdjustment" ("id", "orderId", "type", "sourceId", "code", "amount", "createdAt")
SELECT 'legacy_coupon_' || o.id, o.id, 'COUPON', o."couponId", c.code, -o."couponDiscount", o."createdAt"
FROM "Order" o LEFT JOIN "Coupon" c ON c.id = o."couponId"
WHERE COALESCE(o."pricingVersion", 0) = 0 AND o."couponDiscount" > 0
ON CONFLICT ("id") DO NOTHING;

UPDATE "Order" o
SET "pricingVersion" = 0,
    "currency" = (SELECT s.currency FROM "Store" s WHERE s."singleton"),
    "grandTotal" = o."totalAmount",
    "shippingTotal" = o."shippingFee",
    "taxTotal" = NULL,
    "subtotal" = lines.list,
    "discountTotal" = CASE
      WHEN o."couponId" IS NOT NULL AND o."couponDiscount" IS NULL THEN NULL
      ELSE lines.discount + COALESCE(o."couponDiscount", 0)
    END
FROM (
  SELECT o2.id,
         COALESCE(sum(oi."originalPrice" * oi.quantity), 0) AS list,
         COALESCE(sum((oi."originalPrice" - oi."priceAtOrder") * oi.quantity), 0) AS discount
  FROM "Order" o2 LEFT JOIN "OrderItem" oi ON oi."orderId" = o2.id
  WHERE COALESCE(o2."pricingVersion", 0) = 0
  GROUP BY o2.id
) lines
WHERE lines.id = o.id;

DO $$
DECLARE
  summary text;
BEGIN
  SELECT format('legacy orders (pricingVersion 0): %s, without shippingTotal: %s, without discountTotal: %s, discount adjustments: %s, coupon adjustments: %s',
                (SELECT count(*) FROM "Order" WHERE "pricingVersion" = 0),
                (SELECT count(*) FROM "Order" WHERE "pricingVersion" = 0 AND "shippingTotal" IS NULL),
                (SELECT count(*) FROM "Order" WHERE "pricingVersion" = 0 AND "discountTotal" IS NULL),
                (SELECT count(*) FROM "OrderAdjustment" WHERE id LIKE 'legacy\_discount\_%'),
                (SELECT count(*) FROM "OrderAdjustment" WHERE id LIKE 'legacy\_coupon\_%'))
  INTO summary;
  RAISE NOTICE 'Order totals migration (scripts/reports/order-totals-migration-report.sql): %', summary;
END $$;
