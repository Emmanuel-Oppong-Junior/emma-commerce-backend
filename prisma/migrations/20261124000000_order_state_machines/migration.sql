-- Order, payment and fulfilment state machines, expand + backfill (P1-O.2, ADR-0014).
--   * OrderStatus PENDING/PROCESSING/SHIPPED/DELIVERED/CANCELLED -> PLACED/CONFIRMED/IN_FULFILMENT/COMPLETED/CANCELLED,
--     plus EXPIRED (unpaid order expired) and PAYMENT_REVIEW (paid after it was cancelled or expired).
--   * PaymentIntentStatus PENDING/PAID -> PENDING/CAPTURED/PARTIALLY_REFUNDED/REFUNDED/FAILED/CANCELLED (the order's
--     payment machine); PaymentStatus of an attempt COMPLETED -> CAPTURED, ABANDONED -> CANCELLED.
--   * Shipment (fulfilment machine, one per order for now), OrderStatusEvent and ShipmentStatusEvent (history).
-- 20261124010000_order_state_machines_contract drops Order.trackingNumber and Order.carrier once copied.

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'PICKING', 'PACKED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED_DELIVERY', 'RETURNED');

-- AlterEnum: every old order status maps to exactly one new one.
CREATE TYPE "OrderStatus_new" AS ENUM ('PLACED', 'CONFIRMED', 'IN_FULFILMENT', 'COMPLETED', 'CANCELLED', 'EXPIRED', 'PAYMENT_REVIEW');
ALTER TABLE "Order" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Order" ALTER COLUMN "status" TYPE "OrderStatus_new" USING (
  CASE "status"::text
    WHEN 'PENDING' THEN 'PLACED'
    WHEN 'PROCESSING' THEN 'CONFIRMED'
    WHEN 'SHIPPED' THEN 'IN_FULFILMENT'
    WHEN 'DELIVERED' THEN 'COMPLETED'
    ELSE "status"::text
  END
)::"OrderStatus_new";
DROP TYPE "OrderStatus";
ALTER TYPE "OrderStatus_new" RENAME TO "OrderStatus";
ALTER TABLE "Order" ALTER COLUMN "status" SET DEFAULT 'PLACED';

-- AlterEnum: an attempt superseded by a newer one (ABANDONED) was cancelled, not refused by the provider; a late
-- provider verdict can still settle it, as before.
CREATE TYPE "PaymentStatus_new" AS ENUM ('PENDING', 'CAPTURED', 'FAILED', 'CANCELLED');
ALTER TABLE "PaymentAttempt" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PaymentAttempt" ALTER COLUMN "status" TYPE "PaymentStatus_new" USING (
  CASE "status"::text WHEN 'COMPLETED' THEN 'CAPTURED' WHEN 'ABANDONED' THEN 'CANCELLED' ELSE "status"::text END
)::"PaymentStatus_new";
DROP TYPE "PaymentStatus";
ALTER TYPE "PaymentStatus_new" RENAME TO "PaymentStatus";
ALTER TABLE "PaymentAttempt" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- AlterEnum: PAID -> CAPTURED here; refunds and closed orders are applied by the backfill below.
CREATE TYPE "PaymentIntentStatus_new" AS ENUM ('PENDING', 'CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'FAILED', 'CANCELLED');
ALTER TABLE "PaymentIntent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "PaymentIntent" ALTER COLUMN "status" TYPE "PaymentIntentStatus_new" USING (
  CASE "status"::text WHEN 'PAID' THEN 'CAPTURED' ELSE "status"::text END
)::"PaymentIntentStatus_new";
DROP TYPE "PaymentIntentStatus";
ALTER TYPE "PaymentIntentStatus_new" RENAME TO "PaymentIntentStatus";
ALTER TABLE "PaymentIntent" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "Shipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "from" "OrderStatus",
    "to" "OrderStatus" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentStatusEvent" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "from" "ShipmentStatus",
    "to" "ShipmentStatus" NOT NULL,
    "actorId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shipment_orderId_idx" ON "Shipment"("orderId");

-- CreateIndex
CREATE INDEX "OrderStatusEvent_orderId_createdAt_idx" ON "OrderStatusEvent"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "ShipmentStatusEvent_shipmentId_createdAt_idx" ON "ShipmentStatusEvent"("shipmentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusEvent" ADD CONSTRAINT "OrderStatusEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentStatusEvent" ADD CONSTRAINT "ShipmentStatusEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill, safe to re-run while Order.trackingNumber and Order.carrier exist (20261124010000_order_state_machines_contract
-- refuses to drop them until every tracked order has its shipment). It:
--   * marks CANCELLED orders EXPIRED where the stock ledger shows the expiry job released them (a RELEASE movement
--     noted 'Unpaid order expired', written since P1-N); older expiries cannot be told apart and stay CANCELLED;
--   * marks CANCELLED / EXPIRED orders PAYMENT_REVIEW while they hold a capture flagged ORDER_NOT_PAYABLE whose
--     auto-refund has not been processed (paid after they closed), as payment verification now does;
--   * sets payment intents: CANCELLED when still open on a closed order; for a captured one, PARTIALLY_REFUNDED or
--     REFUNDED from the processed refunds of its accepted capture;
--   * creates a shipment ("legacy_shipment_<orderId>") for orders in or past fulfilment, or with a tracking number or
--     carrier: COMPLETED -> DELIVERED, IN_FULFILMENT -> READY_FOR_PICKUP (pickup) or OUT_FOR_DELIVERY (delivery),
--     otherwise PENDING; carrier and tracking number copied, dates left null (never stored);
--   * writes one history event per order and shipment for its status when migrated (no earlier history is invented);
--   * grants the new order.fulfil permission to the Owner, Manager, Inventory clerk (with order.view) and Cashier roles.
-- Read the result with scripts/reports/order-state-machines-migration-report.sql.

UPDATE "Order" o SET "status" = 'EXPIRED'
WHERE o."status" = 'CANCELLED'
  AND EXISTS (
    SELECT 1 FROM "StockMovement" m
    WHERE m."refType" = 'Order' AND m."refId" = o.id AND m.reason = 'RELEASE' AND m.note = 'Unpaid order expired'
  );

UPDATE "Order" o SET "status" = 'PAYMENT_REVIEW'
WHERE o."status" IN ('CANCELLED', 'EXPIRED')
  AND EXISTS (
    SELECT 1 FROM "PaymentAttempt" pa
    JOIN "PaymentIntent" pi ON pi.id = pa."intentId"
    WHERE pi."orderId" = o.id AND pa."reviewReason" = 'ORDER_NOT_PAYABLE'
      AND NOT EXISTS (
        SELECT 1 FROM "Refund" r WHERE r."attemptId" = pa.id AND r."idempotencyKey" = 'auto-refund:' || pa.id
          AND r.status = 'PROCESSED'
      )
  );

UPDATE "PaymentIntent" pi SET "status" = 'CANCELLED'
FROM "Order" o
WHERE o.id = pi."orderId" AND pi."status" IN ('PENDING', 'FAILED')
  AND o."status" IN ('CANCELLED', 'EXPIRED', 'PAYMENT_REVIEW');

UPDATE "PaymentIntent" pi
SET "status" = (CASE
  WHEN refunded.total <= 0 THEN 'CAPTURED'
  WHEN refunded.total >= refunded.captured THEN 'REFUNDED'
  ELSE 'PARTIALLY_REFUNDED'
END)::"PaymentIntentStatus"
FROM (
  SELECT pa."intentId", max(pa.amount) AS captured,
         COALESCE(sum(r.amount) FILTER (WHERE r.status = 'PROCESSED'), 0) AS total
  FROM "PaymentAttempt" pa
  LEFT JOIN "Refund" r ON r."attemptId" = pa.id
  WHERE pa."status" = 'CAPTURED' AND pa."reviewReason" IS NULL
  GROUP BY pa."intentId"
) refunded
WHERE refunded."intentId" = pi.id AND pi."status" IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED');

INSERT INTO "Shipment" ("id", "orderId", "status", "carrier", "trackingNumber", "createdAt", "updatedAt")
SELECT 'legacy_shipment_' || o.id, o.id,
       (CASE
          WHEN o."status" = 'COMPLETED' THEN 'DELIVERED'
          WHEN o."status" = 'IN_FULFILMENT' AND o."fulfillmentType" = 'PICKUP' THEN 'READY_FOR_PICKUP'
          WHEN o."status" = 'IN_FULFILMENT' THEN 'OUT_FOR_DELIVERY'
          ELSE 'PENDING'
        END)::"ShipmentStatus",
       o.carrier, o."trackingNumber", o."updatedAt", CURRENT_TIMESTAMP
FROM "Order" o
WHERE (o."status" IN ('IN_FULFILMENT', 'COMPLETED') OR o."trackingNumber" IS NOT NULL OR o.carrier IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM "Shipment" s WHERE s."orderId" = o.id)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "OrderStatusEvent" ("id", "orderId", "from", "to", "reason", "createdAt")
SELECT 'legacy_status_' || o.id, o.id, NULL, o."status", 'Status when migrated (P1-O.2)', o."updatedAt"
FROM "Order" o
WHERE NOT EXISTS (SELECT 1 FROM "OrderStatusEvent" e WHERE e."orderId" = o.id)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "ShipmentStatusEvent" ("id", "shipmentId", "from", "to", "reason", "createdAt")
SELECT 'legacy_status_' || s.id, s.id, NULL, s."status", 'Status when migrated (P1-O.2)', s."createdAt"
FROM "Shipment" s
WHERE NOT EXISTS (SELECT 1 FROM "ShipmentStatusEvent" e WHERE e."shipmentId" = s.id)
ON CONFLICT ("id") DO NOTHING;

UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'order.fulfil'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" AND "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK', 'CASHIER')
  AND NOT ('order.fulfil' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'order.view'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" AND "key" = 'INVENTORY_CLERK' AND NOT ('order.view' = ANY ("permissions"));

DO $$
DECLARE
  summary text;
BEGIN
  SELECT format('orders by status: %s; shipments created: %s; intents by status: %s',
                (SELECT COALESCE(string_agg(status || ' ' || n, ', ' ORDER BY status), 'none')
                 FROM (SELECT "status"::text AS status, count(*) AS n FROM "Order" GROUP BY 1) s),
                (SELECT count(*) FROM "Shipment" WHERE id LIKE 'legacy\_shipment\_%'),
                (SELECT COALESCE(string_agg(status || ' ' || n, ', ' ORDER BY status), 'none')
                 FROM (SELECT "status"::text AS status, count(*) AS n FROM "PaymentIntent" GROUP BY 1) s))
  INTO summary;
  RAISE NOTICE 'Order state machines migration (scripts/reports/order-state-machines-migration-report.sql): %', summary;
END $$;
