-- AlterTable: Change monetary Float columns to Decimal(10,2) for financial precision.
-- Float (double precision) is unsuitable for currency — rounding errors accumulate.
-- Decimal(10,2) stores exact values up to 99,999,999.99 with two decimal places.

ALTER TABLE "Order" ALTER COLUMN "totalAmount" TYPE DECIMAL(10,2) USING "totalAmount"::DECIMAL(10,2);

ALTER TABLE "OrderItem" ALTER COLUMN "priceAtOrder" TYPE DECIMAL(10,2) USING "priceAtOrder"::DECIMAL(10,2);

ALTER TABLE "Payment" ALTER COLUMN "amount" TYPE DECIMAL(10,2) USING "amount"::DECIMAL(10,2);
