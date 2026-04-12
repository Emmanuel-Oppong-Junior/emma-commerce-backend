-- Create a sequence for order numbers starting at 10001.
-- nextval() is atomic — concurrent transactions each get a unique number
-- with no locking or application-level coordination required.
CREATE SEQUENCE "order_number_seq" START 10001;

-- Add the column with the sequence as its default so existing rows also
-- receive a unique order number automatically.
ALTER TABLE "Order"
  ADD COLUMN "orderNumber" INTEGER NOT NULL DEFAULT nextval('order_number_seq');

-- Drop the column-level default so Prisma/application code cannot accidentally
-- insert a literal value — every row must get its number from the sequence.
ALTER TABLE "Order" ALTER COLUMN "orderNumber" DROP DEFAULT;

-- Enforce uniqueness at the database level as a safety net.
ALTER TABLE "Order" ADD CONSTRAINT "Order_orderNumber_key" UNIQUE ("orderNumber");
