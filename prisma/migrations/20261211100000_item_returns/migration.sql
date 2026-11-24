-- P6-R.1: item-level returns. A return names order lines and quantities (ReturnLine) with a reason each, moves through
-- REQUESTED -> APPROVED -> RECEIVED -> INSPECTED -> REFUND_PENDING/REFUNDED or EXCHANGED (REJECTED, CANCELLED), and
-- keeps an append-only history (ReturnStatusEvent). Return windows: Store.returnWindowDays (14) with a per product
-- type override and ProductType.returnable. The new return.override permission goes to Owner and Manager.
-- Existing whole-order requests keep their free-text reason ("legacy"); open ones whose order has delivered units get
-- one line per order line with its returnable units. A paid order's cancellation now records a PENDING refund (reason
-- ORDER_CANCELLED) instead of a return request. Every backfill is safe to re-run.

-- AlterEnum (not used in this migration: a value added in a transaction cannot be used in it)
ALTER TYPE "RefundReason" ADD VALUE 'ORDER_CANCELLED';

-- CreateEnum
CREATE TYPE "ReturnReason" AS ENUM ('DAMAGED', 'DEFECTIVE', 'WRONG_ITEM', 'NOT_AS_DESCRIBED', 'CHANGED_MIND', 'SIZE_FIT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReturnResolution" AS ENUM ('REFUND', 'EXCHANGE');

-- AlterEnum: PENDING becomes REQUESTED; the type is recreated so the new values can be used in this migration.
CREATE TYPE "ReturnStatus_new" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'REFUND_PENDING', 'REFUNDED', 'EXCHANGED', 'CANCELLED');
ALTER TABLE "ReturnRequest" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ReturnRequest" ALTER COLUMN "status" TYPE "ReturnStatus_new"
  USING (CASE WHEN "status"::text = 'PENDING' THEN 'REQUESTED' ELSE "status"::text END)::"ReturnStatus_new";
ALTER TYPE "ReturnStatus" RENAME TO "ReturnStatus_old";
ALTER TYPE "ReturnStatus_new" RENAME TO "ReturnStatus";
DROP TYPE "ReturnStatus_old";
ALTER TABLE "ReturnRequest" ALTER COLUMN "status" SET DEFAULT 'REQUESTED';

-- DropIndex
DROP INDEX "ReturnRequest_userId_idx";

-- AlterTable
ALTER TABLE "ProductType" ADD COLUMN     "returnWindowDays" INTEGER,
ADD COLUMN     "returnable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "ReturnRequest" RENAME COLUMN "adminNote" TO "staffNote";
ALTER TABLE "ReturnRequest" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "policyOverrideReason" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "replacementOrderId" TEXT,
ADD COLUMN     "resolution" "ReturnResolution" NOT NULL DEFAULT 'REFUND',
ALTER COLUMN "reason" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "returnWindowDays" INTEGER NOT NULL DEFAULT 14;

-- CreateTable
CREATE TABLE "ReturnLine" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" "ReturnReason" NOT NULL,
    "note" TEXT,
    "photoPublicIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exchangeVariantId" TEXT,
    "receivedQuantity" INTEGER,
    "restockQuantity" INTEGER,
    "writeOffQuantity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReturnStatusEvent" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "from" "ReturnStatus",
    "to" "ReturnStatus" NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReturnStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReturnLine_orderItemId_idx" ON "ReturnLine"("orderItemId");

-- CreateIndex
CREATE INDEX "ReturnLine_exchangeVariantId_idx" ON "ReturnLine"("exchangeVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnLine_returnRequestId_orderItemId_key" ON "ReturnLine"("returnRequestId", "orderItemId");

-- CreateIndex
CREATE INDEX "ReturnStatusEvent_returnRequestId_createdAt_idx" ON "ReturnStatusEvent"("returnRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReturnRequest_replacementOrderId_key" ON "ReturnRequest"("replacementOrderId");

-- CreateIndex
CREATE INDEX "ReturnRequest_userId_createdAt_idx" ON "ReturnRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnRequest_status_createdAt_idx" ON "ReturnRequest"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ReturnRequest_createdAt_idx" ON "ReturnRequest"("createdAt");

-- AddForeignKey
ALTER TABLE "ReturnRequest" ADD CONSTRAINT "ReturnRequest_replacementOrderId_fkey" FOREIGN KEY ("replacementOrderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_exchangeVariantId_fkey" FOREIGN KEY ("exchangeVariantId") REFERENCES "Variant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReturnStatusEvent" ADD CONSTRAINT "ReturnStatusEvent_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "ReturnRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Store" ADD CONSTRAINT "Store_return_window_days_range" CHECK ("returnWindowDays" BETWEEN 0 AND 365);
ALTER TABLE "ProductType" ADD CONSTRAINT "ProductType_return_window_days_range"
  CHECK ("returnWindowDays" IS NULL OR "returnWindowDays" BETWEEN 0 AND 365);

ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_note_for_other" CHECK ("reason" <> 'OTHER' OR "note" IS NOT NULL);
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_photos_at_most_3" CHECK (cardinality("photoPublicIds") <= 3);
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_received_within_quantity"
  CHECK ("receivedQuantity" IS NULL OR "receivedQuantity" BETWEEN 0 AND "quantity");
-- Dispositions come with inspection, after receipt, and account for every unit received.
ALTER TABLE "ReturnLine" ADD CONSTRAINT "ReturnLine_disposition_adds_up"
  CHECK (("restockQuantity" IS NULL) = ("writeOffQuantity" IS NULL)
     AND ("restockQuantity" IS NULL OR ("receivedQuantity" IS NOT NULL AND "restockQuantity" >= 0
          AND "writeOffQuantity" >= 0 AND "restockQuantity" + "writeOffQuantity" = "receivedQuantity")));

CREATE FUNCTION "return_status_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ReturnStatusEvent is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "ReturnStatusEvent_append_only" BEFORE UPDATE OR DELETE ON "ReturnStatusEvent"
  FOR EACH ROW EXECUTE FUNCTION "return_status_event_append_only"();

-- A return line is a line of the request's own order, and a line's units claimed by live returns (not rejected or
-- cancelled; once received, the units that arrived) plus its units refunded outside returns never exceed the units
-- delivered. The service checks this under the order row lock; this is the backstop. The order line's row is locked
-- so concurrent requests queue, and a change that claims no more units than before is not re-checked (a refund
-- staff make later must not block receiving or inspecting a return).
CREATE FUNCTION "return_line_within_delivered"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  delivered INTEGER;
  refunded INTEGER;
  claimed INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."orderItemId" = OLD."orderItemId"
     AND COALESCE(NEW."receivedQuantity", NEW."quantity") <= COALESCE(OLD."receivedQuantity", OLD."quantity") THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM "OrderItem" oi JOIN "ReturnRequest" r ON r."orderId" = oi."orderId"
  WHERE oi."id" = NEW."orderItemId" AND r."id" = NEW."returnRequestId"
  FOR UPDATE OF oi;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ReturnLine: order line % is not on the order of return request %',
      NEW."orderItemId", NEW."returnRequestId";
  END IF;
  SELECT COALESCE(sum(si."quantity"), 0) INTO delivered
  FROM "ShipmentItem" si JOIN "Shipment" s ON s."id" = si."shipmentId"
  WHERE si."orderItemId" = NEW."orderItemId" AND s."status" = 'DELIVERED';
  SELECT COALESCE(sum(rl."quantity"), 0) INTO refunded
  FROM "RefundLine" rl JOIN "Refund" f ON f."id" = rl."refundId"
  WHERE rl."orderItemId" = NEW."orderItemId" AND f."returnRequestId" IS NULL AND f."status" <> 'FAILED';
  SELECT COALESCE(sum(COALESCE(l."receivedQuantity", l."quantity")), 0) INTO claimed
  FROM "ReturnLine" l JOIN "ReturnRequest" r ON r."id" = l."returnRequestId"
  WHERE l."orderItemId" = NEW."orderItemId" AND l."id" <> NEW."id" AND r."status" NOT IN ('REJECTED', 'CANCELLED');
  IF claimed + refunded + COALESCE(NEW."receivedQuantity", NEW."quantity") > delivered THEN
    RAISE EXCEPTION 'ReturnLine: % units of order line % would be returned or refunded, % delivered',
      claimed + refunded + COALESCE(NEW."receivedQuantity", NEW."quantity"), NEW."orderItemId", delivered;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ReturnLine_within_delivered" BEFORE INSERT OR UPDATE ON "ReturnLine"
  FOR EACH ROW EXECUTE FUNCTION "return_line_within_delivered"();

UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'return.override'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER') AND NOT ('return.override' = ANY ("permissions"));

-- Backfill: every existing request starts its history where it is now.
INSERT INTO "ReturnStatusEvent" ("id", "returnRequestId", "from", "to", "note", "createdAt")
SELECT 'return_event_migration_' || r."id", r."id", NULL, r."status", 'Migrated whole-order request', r."createdAt"
FROM "ReturnRequest" r
WHERE NOT EXISTS (SELECT 1 FROM "ReturnStatusEvent" e WHERE e."returnRequestId" = r."id");

-- Backfill: an open (REQUESTED) whole-order request whose order has delivered units gets one line per order line with
-- the units still returnable (delivered, minus refunded outside returns, minus claimed by other live returns), reason
-- OTHER with the request's text as the note. Requests left without lines stay legacy; see
-- scripts/reports/returns-migration-report.sql.
INSERT INTO "ReturnLine" ("id", "returnRequestId", "orderItemId", "quantity", "reason", "note", "createdAt")
SELECT 'return_line_migration_' || r."id" || '_' || oi."id", r."id", oi."id", u."returnable", 'OTHER',
       COALESCE(NULLIF(btrim(r."reason"), ''), 'Whole-order return request'), r."createdAt"
FROM "ReturnRequest" r
JOIN "OrderItem" oi ON oi."orderId" = r."orderId"
CROSS JOIN LATERAL (
  SELECT
    (SELECT COALESCE(sum(si."quantity"), 0) FROM "ShipmentItem" si JOIN "Shipment" s ON s."id" = si."shipmentId"
     WHERE si."orderItemId" = oi."id" AND s."status" = 'DELIVERED')
    - (SELECT COALESCE(sum(rl."quantity"), 0) FROM "RefundLine" rl JOIN "Refund" f ON f."id" = rl."refundId"
       WHERE rl."orderItemId" = oi."id" AND f."returnRequestId" IS NULL AND f."status" <> 'FAILED')
    - (SELECT COALESCE(sum(COALESCE(l."receivedQuantity", l."quantity")), 0)
       FROM "ReturnLine" l JOIN "ReturnRequest" o ON o."id" = l."returnRequestId"
       WHERE l."orderItemId" = oi."id" AND o."status" NOT IN ('REJECTED', 'CANCELLED')) AS "returnable"
) u
WHERE r."status" = 'REQUESTED' AND u."returnable" > 0
  -- Only the newest open request of an order: a duplicate (two raced requests) stays legacy for staff to reject.
  AND r."id" = (SELECT d."id" FROM "ReturnRequest" d WHERE d."orderId" = r."orderId" AND d."status" = 'REQUESTED'
                ORDER BY d."createdAt" DESC, d."id" DESC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM "ReturnLine" l JOIN "ReturnRequest" o ON o."id" = l."returnRequestId"
                  WHERE o."orderId" = r."orderId");
