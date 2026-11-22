-- P3-E.1: velocity checks. The counters live in Redis; the database keeps the store's limit overrides (code defaults
-- apply to rules without a row) and the review flags raised on orders. No backfill: existing orders have no flags.

-- CreateEnum
CREATE TYPE "VelocityRule" AS ENUM ('ORDERS_PER_CUSTOMER_1H', 'ORDERS_PER_CUSTOMER_24H', 'ORDERS_PER_PHONE_24H', 'ORDERS_PER_IP_1H', 'ORDERS_PER_IP_24H', 'PAYMENT_ATTEMPTS_PER_CUSTOMER_1H', 'PAYMENT_ATTEMPTS_PER_IP_1H', 'FAILED_PAYMENTS_PER_CUSTOMER_24H', 'FAILED_PAYMENTS_PER_CARD_24H');

-- CreateEnum
CREATE TYPE "VelocityLevel" AS ENUM ('SOFT', 'HARD');

-- CreateTable
CREATE TABLE "VelocityLimit" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "rule" "VelocityRule" NOT NULL,
    "softLimit" INTEGER NOT NULL,
    "hardLimit" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VelocityLimit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderReviewFlag" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "rule" "VelocityRule" NOT NULL,
    "level" "VelocityLevel" NOT NULL,
    "count" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearNote" TEXT,

    CONSTRAINT "OrderReviewFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VelocityLimit_storeId_rule_key" ON "VelocityLimit"("storeId", "rule");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_clearedAt_createdAt_idx" ON "OrderReviewFlag"("clearedAt", "createdAt");

-- CreateIndex
CREATE INDEX "OrderReviewFlag_orderId_idx" ON "OrderReviewFlag"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderReviewFlag_one_open_per_rule" ON "OrderReviewFlag"("orderId", "rule") WHERE ("clearedAt" IS NULL);

-- AddForeignKey
ALTER TABLE "VelocityLimit" ADD CONSTRAINT "VelocityLimit_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The same rules the API validates: positive limits, the hard limit at or above the soft one.
ALTER TABLE "VelocityLimit" ADD CONSTRAINT "VelocityLimit_limits_valid" CHECK ("softLimit" >= 1 AND "hardLimit" >= "softLimit");

-- A flag fired because its count went above its limit; clearing it records who cleared it.
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_count_above_limit" CHECK ("limit" >= 1 AND "count" > "limit");
ALTER TABLE "OrderReviewFlag" ADD CONSTRAINT "OrderReviewFlag_cleared_by" CHECK (("clearedAt" IS NULL) = ("clearedById" IS NULL));
