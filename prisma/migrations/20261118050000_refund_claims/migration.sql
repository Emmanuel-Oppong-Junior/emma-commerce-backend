-- AlterEnum
ALTER TYPE "RefundStatus" ADD VALUE 'SENDING';

-- AlterEnum
ALTER TYPE "ReturnStatus" ADD VALUE 'REFUND_PENDING';

-- AlterTable
ALTER TABLE "Refund" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "returnRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Refund_returnRequestId_key" ON "Refund"("returnRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_providerRef_key" ON "Refund"("providerRef");

-- CreateIndex
CREATE INDEX "Refund_status_idx" ON "Refund"("status");

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

