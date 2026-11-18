-- DropIndex
DROP INDEX "PaymentAttempt_status_idx";

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_createdAt_idx" ON "PaymentAttempt"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvent_processedAt_receivedAt_idx" ON "WebhookEvent"("processedAt", "receivedAt");

