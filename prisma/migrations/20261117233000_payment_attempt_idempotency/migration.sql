-- AlterTable
ALTER TABLE "PaymentAttempt" ADD COLUMN     "authorizationUrl" TEXT,
ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_intentId_idempotencyKey_key" ON "PaymentAttempt"("intentId", "idempotencyKey");

