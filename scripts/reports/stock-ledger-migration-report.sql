-- Reconciliation report of the stock ledger migration, P1-N.1 (prisma/migrations/20261122000000_stock_ledger).
-- Read-only and safe to re-run: variant and location ids and quantities only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/stock-ledger-migration-report.sql
--
-- OPENING_BALANCE rows ("AuditLog", entity 'StockLedgerMigration'): a variant whose Variant.quantity was not the sum of
-- its InventoryLog history (typically stock inserted without a log). onHand kept Variant.quantity; an OPENING_BALANCE
-- movement of `difference` units makes the ledger add up. `history` is the sum of the copied log rows.

SELECT count(*) AS "openingBalances", COALESCE(sum((details ->> 'difference')::int), 0) AS "netDifference"
FROM "AuditLog"
WHERE entity = 'StockLedgerMigration' AND action = 'OPENING_BALANCE';

SELECT "entityId" AS "variantId", details ->> 'locationId' AS "locationId", (details ->> 'onHand')::int AS "onHand",
       (details ->> 'history')::int AS history, (details ->> 'difference')::int AS difference, "createdAt"
FROM "AuditLog"
WHERE entity = 'StockLedgerMigration' AND action = 'OPENING_BALANCE'
ORDER BY "createdAt", "entityId";

-- Lines of orders open at migration time, recorded as CONSUMED reservations (their stock had already left onHand).
SELECT r."orderId", count(*) AS lines, sum(r.quantity) AS units, o.status AS "orderStatus"
FROM "StockReservation" r JOIN "Order" o ON o.id = r."orderId"
WHERE r.id LIKE 'legacy\_%'
GROUP BY r."orderId", o.status
ORDER BY r."orderId";
