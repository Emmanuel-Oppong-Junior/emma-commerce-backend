-- Reconciliation report of the order totals migration, P1-O.1 (prisma/migrations/20261123000000_order_totals).
-- Read-only and safe to re-run: order ids, counts and amounts only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/order-totals-migration-report.sql
--
-- Legacy orders (pricingVersion 0) carry only what they stored: taxTotal is always null (no tax was recorded),
-- shippingTotal is null where shippingFee was, and discountTotal is null for an order with a coupon but no stored
-- couponDiscount. Their grandTotal is the old totalAmount, the amount that was charged.

SELECT "pricingVersion", count(*) AS orders,
       count(*) FILTER (WHERE "shippingTotal" IS NULL) AS "withoutShippingTotal",
       count(*) FILTER (WHERE "discountTotal" IS NULL) AS "withoutDiscountTotal",
       count(*) FILTER (WHERE "taxTotal" IS NULL) AS "withoutTaxTotal"
FROM "Order"
GROUP BY "pricingVersion"
ORDER BY "pricingVersion";

-- Legacy orders whose stored parts do not add up to what was charged (subtotal - discountTotal + shippingTotal <>
-- grandTotal). These were inconsistent before the migration; nothing was changed to hide it.
SELECT id AS "orderId", subtotal, "discountTotal", "shippingTotal", "grandTotal",
       subtotal - "discountTotal" + "shippingTotal" - "grandTotal" AS difference
FROM "Order"
WHERE "pricingVersion" = 0 AND subtotal IS NOT NULL AND "discountTotal" IS NOT NULL AND "shippingTotal" IS NOT NULL
  AND subtotal - "discountTotal" + "shippingTotal" <> "grandTotal"
ORDER BY "createdAt";

-- Adjustments the migration created from stored discounts and coupons.
SELECT type, count(*) AS adjustments, sum(amount) AS total
FROM "OrderAdjustment"
WHERE id LIKE 'legacy\_%'
GROUP BY type;

-- Nightly check for priced orders (ROADMAP migration rule 9): Σ line nets + order adjustments + tax + shipping must
-- equal the grand total. Any row here is a bug.
SELECT o.id AS "orderId", o."grandTotal",
       COALESCE(l.nets, 0) + COALESCE(a.adjustments, 0) + o."taxTotal" + o."shippingTotal" AS "sumOfParts"
FROM "Order" o
LEFT JOIN (SELECT "orderId", sum("unitNet" * quantity) AS nets FROM "OrderItem" GROUP BY "orderId") l ON l."orderId" = o.id
LEFT JOIN (SELECT "orderId", sum(amount) AS adjustments FROM "OrderAdjustment" WHERE "orderItemId" IS NULL
           GROUP BY "orderId") a ON a."orderId" = o.id
WHERE o."pricingVersion" >= 1
  AND COALESCE(l.nets, 0) + COALESCE(a.adjustments, 0) + o."taxTotal" + o."shippingTotal" <> o."grandTotal";
