-- Payment.transactionId becomes PaymentAttempt.reference, which is UNIQUE. Two payments sharing a Paystack
-- reference cannot be split without guessing which one the money belongs to, so stop and let ops decide.
-- Run scripts/payment-ledger-backfill-report.js first: it lists these rows.
DO $$
DECLARE
  duplicated integer;
BEGIN
  SELECT count(*) INTO duplicated FROM (
    SELECT "transactionId" FROM "Payment" WHERE "transactionId" IS NOT NULL
    GROUP BY "transactionId" HAVING count(*) > 1
  ) d;
  IF duplicated > 0 THEN
    RAISE EXCEPTION 'payment_ledger: % Paystack reference(s) are shared by more than one Payment row; resolve them before migrating', duplicated;
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('PENDING', 'PAID');

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('PAYSTACK', 'CASH_ON_DELIVERY');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'ABANDONED';

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" TEXT NOT NULL,
    "intentId" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "reference" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "rawStatus" TEXT,
    "channel" TEXT NOT NULL,
    "providerDetails" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "providerRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "reference" TEXT,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashCollection" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "attemptId" TEXT,
    "riderId" TEXT,
    "recordedById" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'GHS',
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashCollection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentIntent_orderId_key" ON "PaymentIntent"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_reference_key" ON "PaymentAttempt"("reference");

-- CreateIndex
CREATE INDEX "PaymentAttempt_intentId_idx" ON "PaymentAttempt"("intentId");

-- CreateIndex
CREATE INDEX "PaymentAttempt_status_idx" ON "PaymentAttempt"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_idempotencyKey_key" ON "Refund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Refund_attemptId_idx" ON "Refund"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_provider_eventKey_key" ON "WebhookEvent"("provider", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "CashCollection_attemptId_key" ON "CashCollection"("attemptId");

-- CreateIndex
CREATE INDEX "CashCollection_orderId_idx" ON "CashCollection"("orderId");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_intentId_fkey" FOREIGN KEY ("intentId") REFERENCES "PaymentIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (M3): every Payment row becomes a PaymentAttempt with the same id, under one PaymentIntent per order.
-- Deterministic ids and ON CONFLICT DO NOTHING make each statement safe to re-run.
INSERT INTO "PaymentIntent" ("id", "orderId", "amount", "currency", "status", "createdAt", "updatedAt")
SELECT
  'pi_' || p."id",
  p."orderId",
  o."totalAmount",
  'GHS',
  (CASE WHEN p."status" = 'COMPLETED' THEN 'PAID' ELSE 'PENDING' END)::"PaymentIntentStatus",
  p."createdAt",
  p."updatedAt"
FROM "Payment" p
JOIN "Order" o ON o."id" = p."orderId"
ON CONFLICT ("orderId") DO NOTHING;

INSERT INTO "PaymentAttempt" (
  "id", "intentId", "provider", "reference", "amount", "currency", "status", "rawStatus", "channel",
  "providerDetails", "createdAt", "updatedAt", "deleted", "deletedAt"
)
SELECT
  p."id",
  i."id",
  (CASE
    WHEN o."paymentMethod" = 'CASH_ON_DELIVERY' OR p."paymentMethod" = 'CASH_ON_DELIVERY' THEN 'CASH_ON_DELIVERY'
    ELSE 'PAYSTACK'
  END)::"PaymentProvider",
  p."transactionId",
  p."amount",
  p."currency",
  p."status",
  CASE WHEN jsonb_typeof(p."paymentDetails") = 'object' THEN p."paymentDetails" ->> 'status' END,
  p."paymentMethod",
  p."paymentDetails",
  p."createdAt",
  p."updatedAt",
  p."deleted",
  p."deletedAt"
FROM "Payment" p
JOIN "Order" o ON o."id" = p."orderId"
JOIN "PaymentIntent" i ON i."orderId" = p."orderId"
ON CONFLICT ("id") DO NOTHING;

-- Who collected the cash was never stored, so riderId and recordedById stay NULL for legacy collections.
INSERT INTO "CashCollection" ("id", "orderId", "attemptId", "amount", "currency", "collectedAt", "createdAt")
SELECT 'cc_' || a."id", i."orderId", a."id", a."amount", a."currency", a."createdAt", a."createdAt"
FROM "PaymentAttempt" a
JOIN "PaymentIntent" i ON i."id" = a."intentId"
WHERE a."provider" = 'CASH_ON_DELIVERY' AND a."status" = 'COMPLETED'
ON CONFLICT ("attemptId") DO NOTHING;

-- Refunds were only ever sent to Paystack, never stored. A REFUNDED return request means Paystack accepted the
-- refund request, not that it settled, so these start PENDING until ops confirm them against the Paystack export.
INSERT INTO "Refund" ("id", "attemptId", "amount", "status", "idempotencyKey", "createdAt", "updatedAt")
SELECT 'rf_' || r."id", p."id", r."refundAmount", 'PENDING', 'return-request:' || r."id", r."updatedAt", r."updatedAt"
FROM "ReturnRequest" r
JOIN "Payment" p ON p."orderId" = r."orderId"
WHERE r."status" = 'REFUNDED' AND r."refundAmount" IS NOT NULL AND p."transactionId" IS NOT NULL
ON CONFLICT ("idempotencyKey") DO NOTHING;

-- Nothing may be lost: refuse to drop the old table unless every Payment row has its attempt.
DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing FROM "Payment" p WHERE NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."id" = p."id");
  IF missing > 0 THEN
    RAISE EXCEPTION 'payment_ledger: % Payment row(s) were not copied to PaymentAttempt', missing;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_orderId_fkey";

-- DropTable
DROP TABLE "Payment";

-- Ledger rows are financial records: corrections are new rows or status changes, never deletes (DB-02).
-- Prisma cannot declare triggers. TRUNCATE does not fire row triggers, which is how test databases are reset.
CREATE FUNCTION "payment_ledger_forbid_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows in "%" are financial records and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "PaymentIntent_forbid_delete" BEFORE DELETE ON "PaymentIntent"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();
CREATE TRIGGER "PaymentAttempt_forbid_delete" BEFORE DELETE ON "PaymentAttempt"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();
CREATE TRIGGER "Refund_forbid_delete" BEFORE DELETE ON "Refund"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();
CREATE TRIGGER "CashCollection_forbid_delete" BEFORE DELETE ON "CashCollection"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();
