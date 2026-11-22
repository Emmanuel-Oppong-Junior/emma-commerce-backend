-- P3-B.3: who collected each cash-on-delivery payment (a staff account for now), the cash riders hand to the store
-- (remittances) and the difference between the two. No backfill: collections recorded before keep riderId null.

-- AlterTable
ALTER TABLE "CashCollection" ADD COLUMN     "remittanceId" TEXT;

-- CreateTable
CREATE TABLE "CashRemittance" (
    "id" TEXT NOT NULL,
    "riderId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "expectedAmount" DECIMAL(14,2) NOT NULL,
    "discrepancy" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashRemittance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashRemittance_riderId_receivedAt_idx" ON "CashRemittance"("riderId", "receivedAt");

-- CreateIndex
CREATE INDEX "CashRemittance_receivedAt_idx" ON "CashRemittance"("receivedAt");

-- CreateIndex
CREATE INDEX "CashCollection_riderId_collectedAt_idx" ON "CashCollection"("riderId", "collectedAt");

-- CreateIndex
CREATE INDEX "CashCollection_remittanceId_idx" ON "CashCollection"("remittanceId");

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashCollection" ADD CONSTRAINT "CashCollection_remittanceId_fkey" FOREIGN KEY ("remittanceId") REFERENCES "CashRemittance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_amounts_not_negative"
  CHECK ("amount" >= 0 AND "expectedAmount" >= 0);
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_discrepancy"
  CHECK ("discrepancy" = "amount" - "expectedAmount");
-- A short or over remittance must say why.
ALTER TABLE "CashRemittance" ADD CONSTRAINT "CashRemittance_discrepancy_note"
  CHECK ("discrepancy" = 0 OR btrim(COALESCE("note", '')) <> '');

-- Remittances are financial records: never updated or deleted (a correction is a new remittance).
CREATE TRIGGER "CashRemittance_forbid_delete" BEFORE DELETE ON "CashRemittance"
  FOR EACH ROW EXECUTE FUNCTION "payment_ledger_forbid_delete"();

CREATE FUNCTION "cash_remittance_forbid_update"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows in "%" are financial records and cannot be changed', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "CashRemittance_forbid_update" BEFORE UPDATE ON "CashRemittance"
  FOR EACH ROW EXECUTE FUNCTION "cash_remittance_forbid_update"();

-- A collection changes once, when it is remitted: remittanceId goes from null to a remittance and nothing else
-- changes. Comparing the rows without remittanceId keeps the rule true for columns added later.
CREATE FUNCTION "cash_collection_remit_once"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."remittanceId" IS NULL AND NEW."remittanceId" IS NOT NULL
     AND (to_jsonb(OLD) - 'remittanceId') = (to_jsonb(NEW) - 'remittanceId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Rows in "%" are financial records: only an unremitted collection can be linked to a remittance', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER "CashCollection_remit_once" BEFORE UPDATE ON "CashCollection"
  FOR EACH ROW EXECUTE FUNCTION "cash_collection_remit_once"();

-- Who may record remittances and read the cash report: the new cod.cash.manage permission, granted to the Owner (who
-- holds every permission anyway), the Manager and the Cashier, who already record cash collections. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'cod.cash.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'CASHIER')
  AND NOT ('cod.cash.manage' = ANY ("permissions"));
