-- P6-L.2: referrals. Each customer gets a referral code (User.referralCode, created when first asked for); a new
-- customer enters one at sign-up or before their first order (Referral, one per new customer). When their first
-- signed-in order completes, both are rewarded with REFERRAL loyalty points (Store.referralReferrerPoints and
-- referralNewCustomerPoints, 500 each); a full refund within the return window takes them back. A new velocity rule
-- counts referral sign-ups per referrer. Nothing to backfill.

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('PENDING', 'REWARDED', 'REVERSED', 'DISQUALIFIED');

-- AlterEnum (not used in this migration: a value added in a transaction cannot be used in it)
ALTER TYPE "VelocityRule" ADD VALUE 'REFERRALS_PER_REFERRER_24H';

-- AlterTable
ALTER TABLE "LoyaltyTransaction" ADD COLUMN     "referralId" TEXT;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "referralNewCustomerPoints" INTEGER NOT NULL DEFAULT 500,
ADD COLUMN     "referralReferrerPoints" INTEGER NOT NULL DEFAULT 500;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "referralCode" VARCHAR(16);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "refereeId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'PENDING',
    "orderId" TEXT,
    "disqualifiedReason" VARCHAR(40),
    "velocityFlagged" BOOLEAN NOT NULL DEFAULT false,
    "referrerPoints" INTEGER NOT NULL DEFAULT 0,
    "refereePoints" INTEGER NOT NULL DEFAULT 0,
    "rewardedAt" TIMESTAMP(3),
    "reversedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeId_key" ON "Referral"("refereeId");

-- CreateIndex
CREATE INDEX "Referral_referrerId_createdAt_idx" ON "Referral"("referrerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LoyaltyTransaction_referral_per_account_key" ON "LoyaltyTransaction"("referralId", "userId") WHERE (type = 'REFERRAL'::"LoyaltyTransactionType");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Referral" ADD CONSTRAINT "Referral_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "Referral" ADD CONSTRAINT "Referral_not_self_check" CHECK ("referrerId" <> "refereeId"),
  ADD CONSTRAINT "Referral_points_check" CHECK ("referrerPoints" >= 0 AND "refereePoints" >= 0),
  ADD CONSTRAINT "Referral_status_check" CHECK (
    ("status" = 'PENDING' AND "rewardedAt" IS NULL AND "reversedAt" IS NULL AND "disqualifiedReason" IS NULL)
    OR ("status" = 'REWARDED' AND "rewardedAt" IS NOT NULL AND "orderId" IS NOT NULL AND "reversedAt" IS NULL)
    OR ("status" = 'REVERSED' AND "rewardedAt" IS NOT NULL AND "reversedAt" IS NOT NULL)
    OR ("status" = 'DISQUALIFIED' AND "disqualifiedReason" IS NOT NULL AND "orderId" IS NOT NULL));
ALTER TABLE "Store" ADD CONSTRAINT "Store_referral_points_check"
  CHECK ("referralReferrerPoints" BETWEEN 0 AND 100000 AND "referralNewCustomerPoints" BETWEEN 0 AND 100000);
