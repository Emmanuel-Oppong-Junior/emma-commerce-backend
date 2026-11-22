-- P3-E.2: chargeback and dispute records, from Paystack dispute webhooks or recorded by staff, with append-only
-- evidence notes and status history. No backfill.

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'AWAITING_EVIDENCE', 'UNDER_REVIEW', 'WON', 'LOST', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "DisputeSource" AS ENUM ('PROVIDER', 'STAFF');

-- CreateTable
CREATE TABLE "Dispute" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "providerDisputeId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "category" TEXT,
    "reason" TEXT,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "source" "DisputeSource" NOT NULL,
    "evidenceDueAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeNote" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisputeEvent" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "fromStatus" "DisputeStatus",
    "toStatus" "DisputeStatus" NOT NULL,
    "source" "DisputeSource" NOT NULL,
    "actorId" TEXT,
    "providerStatus" TEXT,
    "webhookEventId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisputeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Dispute_attemptId_status_idx" ON "Dispute"("attemptId", "status");

-- CreateIndex
CREATE INDEX "Dispute_orderId_idx" ON "Dispute"("orderId");

-- CreateIndex
CREATE INDEX "Dispute_status_openedAt_idx" ON "Dispute"("status", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Dispute_provider_providerDisputeId_key" ON "Dispute"("provider", "providerDisputeId");

-- CreateIndex
CREATE INDEX "DisputeNote_disputeId_createdAt_idx" ON "DisputeNote"("disputeId", "createdAt");

-- CreateIndex
CREATE INDEX "DisputeEvent_disputeId_createdAt_idx" ON "DisputeEvent"("disputeId", "createdAt");

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeNote" ADD CONSTRAINT "DisputeNote_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisputeEvent" ADD CONSTRAINT "DisputeEvent_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "Dispute"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_amount_not_negative" CHECK ("amount" >= 0);
-- A resolved dispute (WON, LOST, ACCEPTED) has its resolution time; an unresolved one has none.
ALTER TABLE "Dispute" ADD CONSTRAINT "Dispute_resolved_at" CHECK (("resolvedAt" IS NOT NULL) = ("status" IN ('WON', 'LOST', 'ACCEPTED')));

-- Notes and history are append-only. Deleting a dispute still removes its rows: those deletes run inside the
-- foreign-key cascade trigger, so they are nested one trigger level deeper than a direct DELETE.
CREATE FUNCTION "dispute_history_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END $$;
CREATE TRIGGER "DisputeNote_append_only" BEFORE UPDATE OR DELETE ON "DisputeNote"
  FOR EACH ROW EXECUTE FUNCTION "dispute_history_append_only"();
CREATE TRIGGER "DisputeEvent_append_only" BEFORE UPDATE OR DELETE ON "DisputeEvent"
  FOR EACH ROW EXECUTE FUNCTION "dispute_history_append_only"();

-- Who may record disputes, add evidence notes and change their status: the new payment.dispute.manage permission,
-- granted to the Owner (who holds every permission anyway) and the Manager, who handle refunds. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'payment.dispute.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('payment.dispute.manage' = ANY ("permissions"));
