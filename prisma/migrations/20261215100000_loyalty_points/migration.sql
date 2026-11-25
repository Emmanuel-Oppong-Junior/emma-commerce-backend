-- P6-L.1: loyalty points. Signed-in customers earn points on COMPLETED orders (append-only LoyaltyTransaction ledger,
-- the balance on LoyaltyAccount, credited points in LoyaltyLot spent oldest expiry first) and redeem them at checkout
-- as a LOYALTY_POINTS order adjustment. Store settings for the rates, minimum, cap and expiry. The new loyalty.manage
-- permission goes to Owner and Manager. Nothing to backfill: earlier orders never earn.

-- CreateEnum
CREATE TYPE "LoyaltyTransactionType" AS ENUM ('EARN', 'REDEEM', 'REDEEM_RETURN', 'REVERSE', 'EXPIRE', 'ADJUST', 'REFERRAL');

-- AlterEnum (not used in this migration: a value added in a transaction cannot be used in it)
ALTER TYPE "OrderAdjustmentType" ADD VALUE 'LOYALTY_POINTS';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "loyaltyPointsRedeemed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "loyaltyEarnPointsPerCedi" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "loyaltyMaxRedeemPercent" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "loyaltyMinRedeemPoints" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "loyaltyPointsExpiryMonths" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "loyaltyRedeemPointsPerCedi" INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE "LoyaltyAccount" (
    "userId" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "debt" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoyaltyAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "LoyaltyLot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoyaltyTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "LoyaltyTransactionType" NOT NULL,
    "points" INTEGER NOT NULL,
    "debtChange" INTEGER NOT NULL DEFAULT 0,
    "orderId" TEXT,
    "lotId" TEXT,
    "draws" JSONB,
    "reason" VARCHAR(500),
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyLot_transactionId_key" ON "LoyaltyLot"("transactionId");

-- CreateIndex
CREATE INDEX "LoyaltyLot_userId_expiresAt_idx" ON "LoyaltyLot"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "LoyaltyLot_expiresAt_idx" ON "LoyaltyLot"("expiresAt");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_userId_createdAt_idx" ON "LoyaltyTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "LoyaltyTransaction_orderId_idx" ON "LoyaltyTransaction"("orderId");

-- AddForeignKey
ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyLot" ADD CONSTRAINT "LoyaltyLot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LoyaltyAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyLot" ADD CONSTRAINT "LoyaltyLot_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LoyaltyTransaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "LoyaltyAccount"("userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- One earn and one redemption per order.
CREATE UNIQUE INDEX "LoyaltyTransaction_earn_per_order_key" ON "LoyaltyTransaction"("orderId") WHERE "type" = 'EARN';
CREATE UNIQUE INDEX "LoyaltyTransaction_redeem_per_order_key" ON "LoyaltyTransaction"("orderId") WHERE "type" = 'REDEEM';

ALTER TABLE "LoyaltyAccount" ADD CONSTRAINT "LoyaltyAccount_balance_check" CHECK ("balance" >= 0),
  ADD CONSTRAINT "LoyaltyAccount_debt_check" CHECK ("debt" >= 0);
ALTER TABLE "LoyaltyLot" ADD CONSTRAINT "LoyaltyLot_remaining_check"
  CHECK ("points" > 0 AND "remaining" >= 0 AND "remaining" <= "points");
ALTER TABLE "LoyaltyTransaction" ADD CONSTRAINT "LoyaltyTransaction_change_check" CHECK ("points" <> 0 OR "debtChange" <> 0),
  ADD CONSTRAINT "LoyaltyTransaction_adjust_reason_check"
  CHECK ("type" <> 'ADJUST' OR ("reason" IS NOT NULL AND "actorId" IS NOT NULL));
ALTER TABLE "Order" ADD CONSTRAINT "Order_loyaltyPointsRedeemed_check" CHECK ("loyaltyPointsRedeemed" >= 0);
ALTER TABLE "Store" ADD CONSTRAINT "Store_loyalty_settings_check" CHECK (
  "loyaltyEarnPointsPerCedi" BETWEEN 0 AND 100
  AND "loyaltyRedeemPointsPerCedi" BETWEEN 1 AND 10000
  AND "loyaltyMinRedeemPoints" BETWEEN 1 AND 1000000
  AND "loyaltyMaxRedeemPercent" BETWEEN 1 AND 100
  AND "loyaltyPointsExpiryMonths" BETWEEN 1 AND 120);

CREATE FUNCTION "loyalty_transaction_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'LoyaltyTransaction is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "LoyaltyTransaction_append_only" BEFORE UPDATE OR DELETE ON "LoyaltyTransaction"
  FOR EACH ROW EXECUTE FUNCTION "loyalty_transaction_append_only"();

UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'loyalty.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER') AND NOT ('loyalty.manage' = ANY ("permissions"));
