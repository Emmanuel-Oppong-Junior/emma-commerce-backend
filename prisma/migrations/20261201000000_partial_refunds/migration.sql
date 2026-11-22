-- P3-C.1: partial refunds by line, amount and shipping, with a reason; the line's share of order-level adjustments.

-- CreateEnum
CREATE TYPE "RefundReason" AS ENUM ('CUSTOMER_REQUEST', 'DAMAGED', 'WRONG_ITEM', 'NOT_DELIVERED', 'PRICE_ADJUSTMENT', 'DUPLICATE_CHARGE', 'OTHER', 'RETURN', 'PAYMENT_NOT_ACCEPTED');

-- CreateEnum
CREATE TYPE "RefundMethod" AS ENUM ('PROVIDER', 'CASH');

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "orderAdjustmentShare" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "method" "RefundMethod" NOT NULL DEFAULT 'PROVIDER',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "reason" "RefundReason",
ADD COLUMN     "shippingAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Backfill (re-runnable): refunds so far came from return requests or from auto-refunds of charges not accepted.
UPDATE "Refund" SET "reason" = CASE
    WHEN "returnRequestId" IS NOT NULL THEN 'RETURN'::"RefundReason"
    WHEN "idempotencyKey" LIKE 'auto-refund:%' THEN 'PAYMENT_NOT_ACCEPTED'::"RefundReason"
    ELSE 'OTHER'::"RefundReason"
  END
WHERE "reason" IS NULL;

ALTER TABLE "Refund" ALTER COLUMN "reason" SET NOT NULL;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_shippingAmount_check" CHECK ("shippingAmount" >= 0);

-- CreateTable
CREATE TABLE "RefundLine" (
    "id" TEXT NOT NULL,
    "refundId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "RefundLine_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RefundLine_quantity_check" CHECK ("quantity" > 0),
    CONSTRAINT "RefundLine_amount_check" CHECK ("amount" >= 0)
);

-- CreateIndex
CREATE INDEX "RefundLine_orderItemId_idx" ON "RefundLine"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "RefundLine_refundId_orderItemId_key" ON "RefundLine"("refundId", "orderItemId");

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLine" ADD CONSTRAINT "RefundLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Refund lines are part of the payment ledger: never deleted, like the refunds they belong to.
CREATE TRIGGER "RefundLine_forbid_delete" BEFORE DELETE ON "RefundLine"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();

-- Backfill (re-runnable): orders placed before this stored no per-line share of their cart adjustments. Approximate
-- it in proportion to the line totals, rounded to the pesewa, the rounding remainder on the largest line.
WITH totals AS (
  SELECT "orderId", SUM("amount") AS total
  FROM "OrderAdjustment"
  WHERE "orderItemId" IS NULL AND "target" = 'MERCHANDISE'
  GROUP BY "orderId"
), lines AS (
  SELECT oi."id", oi."orderId", oi."lineTotal", t.total,
         SUM(oi."lineTotal") OVER (PARTITION BY oi."orderId") AS "orderLines",
         ROW_NUMBER() OVER (PARTITION BY oi."orderId" ORDER BY oi."lineTotal" DESC, oi."id") AS rank
  FROM "OrderItem" oi JOIN totals t ON t."orderId" = oi."orderId"
), shares AS (
  SELECT "id", "orderId", rank, total,
         CASE WHEN "orderLines" = 0 THEN 0 ELSE ROUND(total * "lineTotal" / "orderLines", 2) END AS share
  FROM lines
), allocated AS (
  SELECT "id",
         CASE WHEN rank = 1 THEN share + total - SUM(share) OVER (PARTITION BY "orderId") ELSE share END AS share
  FROM shares
)
UPDATE "OrderItem" oi SET "orderAdjustmentShare" = a.share
FROM allocated a
WHERE oi."id" = a."id" AND oi."orderAdjustmentShare" <> a.share;
