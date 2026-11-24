-- Report of the item-level returns migration, P6-R.1 (prisma/migrations/20261211100000_item_returns).
-- Read-only and safe to re-run: ids, statuses and amounts only (no reasons, notes or personal data).
--   psql "$DATABASE_URL" -f scripts/reports/returns-migration-report.sql

-- Whole-order requests left without lines ("legacy"), by status: REQUESTED ones had nothing returnable (nothing
-- delivered, e.g. the automatic request of a cancelled paid order, or a duplicate request of an order). Reject them
-- (rejectReturn), refunding with refundOrder where money is owed.
SELECT r.status::text, count(*) AS "requests"
FROM "ReturnRequest" r
WHERE NOT EXISTS (SELECT 1 FROM "ReturnLine" l WHERE l."returnRequestId" = r.id)
GROUP BY r.status
ORDER BY r.status::text;

-- Open legacy requests to act on: APPROVED ones refund their approved amount with refundReturn (or are rejected);
-- REFUND_PENDING ones resend their refund with refundReturn once its outcome is known.
SELECT r.id AS "returnRequestId", r."orderId", r.status::text, r."refundAmount"::text,
       f.id AS "refundId", f.status::text AS "refundStatus",
       (SELECT COALESCE(sum(si.quantity), 0) FROM "ShipmentItem" si
        JOIN "Shipment" s ON s.id = si."shipmentId" JOIN "OrderItem" oi ON oi.id = si."orderItemId"
        WHERE oi."orderId" = r."orderId" AND s.status = 'DELIVERED') AS "unitsDelivered"
FROM "ReturnRequest" r
LEFT JOIN "Refund" f ON f."returnRequestId" = r.id
WHERE r.status IN ('REQUESTED', 'APPROVED', 'REFUND_PENDING')
  AND NOT EXISTS (SELECT 1 FROM "ReturnLine" l WHERE l."returnRequestId" = r.id)
ORDER BY r."createdAt";

-- Requests the migration gave lines to: check them in the returns queue (reason OTHER, the old text as the note).
SELECT r.id AS "returnRequestId", r."orderId", count(l.id) AS "lines", sum(l.quantity) AS "units"
FROM "ReturnRequest" r
JOIN "ReturnLine" l ON l."returnRequestId" = r.id
WHERE l.id LIKE 'return_line_migration_%'
GROUP BY r.id, r."orderId"
ORDER BY r.id;
