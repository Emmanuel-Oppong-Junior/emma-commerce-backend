-- Report of the order state machines migration, P1-O.2 (prisma/migrations/20261124000000_order_state_machines).
-- Read-only and safe to re-run: ids, statuses and counts only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/order-state-machines-migration-report.sql
--
-- Old -> new order status: PENDING -> PLACED, PROCESSING -> CONFIRMED, SHIPPED -> IN_FULFILMENT, DELIVERED -> COMPLETED,
-- CANCELLED -> CANCELLED. A CANCELLED order became EXPIRED only where the stock ledger shows the expiry job released
-- it, and PAYMENT_REVIEW while it holds a late capture whose auto-refund is unprocessed. Orders migrated carry one
-- history event "Status when migrated (P1-O.2)".

SELECT status, count(*) AS orders FROM "Order" GROUP BY status ORDER BY status;

-- Cancellations the data could not classify: cancelled before the stock ledger (P1-N) recorded why, so they stay
-- CANCELLED even if some were expiries.
SELECT count(*) AS "cancelledWithoutLedgerReason"
FROM "Order" o
WHERE o.status = 'CANCELLED'
  AND NOT EXISTS (SELECT 1 FROM "StockMovement" m WHERE m."refType" = 'Order' AND m."refId" = o.id AND m.reason = 'RELEASE');

-- Payment intents by status, and attempts by status (COMPLETED -> CAPTURED, ABANDONED -> CANCELLED).
SELECT status, count(*) AS intents FROM "PaymentIntent" GROUP BY status ORDER BY status;
SELECT status, count(*) AS attempts FROM "PaymentAttempt" GROUP BY status ORDER BY status;

-- Shipments created from the old order fields, by status, and how many have no tracking number.
SELECT status, count(*) AS shipments, count(*) FILTER (WHERE "trackingNumber" IS NULL) AS "withoutTracking"
FROM "Shipment"
WHERE id LIKE 'legacy\_shipment\_%'
GROUP BY status
ORDER BY status;

-- Orders waiting in PAYMENT_REVIEW: send their auto-refunds (refunds(status: PENDING) / processPendingRefund).
SELECT o.id AS "orderId", r.id AS "refundId", r.amount, r.status AS "refundStatus"
FROM "Order" o
JOIN "PaymentIntent" pi ON pi."orderId" = o.id
JOIN "PaymentAttempt" pa ON pa."intentId" = pi.id
JOIN "Refund" r ON r."attemptId" = pa.id AND r."idempotencyKey" = 'auto-refund:' || pa.id
WHERE o.status = 'PAYMENT_REVIEW'
ORDER BY o."createdAt";
