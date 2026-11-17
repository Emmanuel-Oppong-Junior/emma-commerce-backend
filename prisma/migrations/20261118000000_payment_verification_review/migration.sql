-- CreateEnum
CREATE TYPE "PaymentReviewReason" AS ENUM ('AMOUNT_MISMATCH', 'CURRENCY_MISMATCH', 'ORDER_NOT_PAYABLE', 'ALREADY_PAID');

-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "reviewReason" "PaymentReviewReason";

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'GHS';

