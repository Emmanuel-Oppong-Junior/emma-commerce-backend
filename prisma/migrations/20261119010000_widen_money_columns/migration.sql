-- Money columns become DECIMAL(14,2) and tax rates DECIMAL(9,6) (ADR-0004).
-- Raising the precision of a DECIMAL(10,2) column keeps its scale, so Postgres changes the type without rewriting
-- the table. Ledger tables keep their delete-forbidding triggers: changing a column type deletes no rows.

-- These three had no declared precision (DECIMAL(65,30)): values are rounded half-up to 2 dp, exactly what ROUND does.
ALTER TABLE "Discount" ALTER COLUMN "value" SET DATA TYPE DECIMAL(14,2) USING ROUND("value", 2);
ALTER TABLE "Order" ALTER COLUMN "discountTotal" SET DATA TYPE DECIMAL(14,2) USING ROUND("discountTotal", 2);
ALTER TABLE "Order" ALTER COLUMN "totalWithOutDiscount" SET DATA TYPE DECIMAL(14,2) USING ROUND("totalWithOutDiscount", 2);

ALTER TABLE "Variant" ALTER COLUMN "price" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Product" ALTER COLUMN "price" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "currentPrice" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "basePrice" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Discount" ALTER COLUMN "minimumPurchase" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "CartItem" ALTER COLUMN "originalPrice" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "discountedPrice" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Order" ALTER COLUMN "subtotal" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "shippingFee" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "totalAmount" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "couponDiscount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "OrderItem" ALTER COLUMN "priceAtOrder" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "originalPrice" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "discountAmount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "PaymentIntent" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);
ALTER TABLE "PaymentAttempt" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);
ALTER TABLE "Refund" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);
ALTER TABLE "CashCollection" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "Coupon" ALTER COLUMN "value" SET DATA TYPE DECIMAL(14,2),
  ALTER COLUMN "minimumOrderAmount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "ReturnRequest" ALTER COLUMN "refundAmount" SET DATA TYPE DECIMAL(14,2);

ALTER TABLE "ShippingZone" ALTER COLUMN "fee" SET DATA TYPE DECIMAL(14,2);

-- Rates gain precision and scale (4 to 6 dp); every DECIMAL(5,4) value fits DECIMAL(9,6) unchanged.
ALTER TABLE "Tax" ALTER COLUMN "rate" SET DATA TYPE DECIMAL(9,6);
