-- Report of the order line cost backfill, P8-A (prisma/migrations/20261216100000_order_line_cost).
-- Read-only and safe to re-run: counts only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/order-line-cost-report.sql

-- Order lines by cost snapshot: recorded with a cost, recorded with an unknown cost (sold before any cost was set:
-- margins report them apart), or never recorded (stock not consumed yet, or sold before the stock ledger).
SELECT
  count(*) FILTER (WHERE "costRecordedAt" IS NOT NULL AND "unitCost" IS NOT NULL) AS "linesWithCost",
  count(*) FILTER (WHERE "costRecordedAt" IS NOT NULL AND "unitCost" IS NULL) AS "linesWithUnknownCost",
  count(*) FILTER (WHERE "costRecordedAt" IS NULL) AS "linesNotRecorded"
FROM "OrderItem";

-- Variants with sold lines of unknown cost: set an opening cost with setVariantCost for future sales.
SELECT oi."variantId", count(*) AS lines, sum(oi.quantity) AS units
FROM "OrderItem" oi
WHERE oi."costRecordedAt" IS NOT NULL AND oi."unitCost" IS NULL
GROUP BY oi."variantId"
ORDER BY units DESC
LIMIT 50;
