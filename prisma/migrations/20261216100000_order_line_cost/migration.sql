-- P8-A: the variant's weighted-average cost is snapshotted on the order line when the sale's stock is consumed.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "costRecordedAt" TIMESTAMP(3),
ADD COLUMN     "unitCost" DECIMAL(14,4);

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_unitCost_recorded"
  CHECK ("unitCost" IS NULL OR ("costRecordedAt" IS NOT NULL AND "unitCost" >= 0));

-- Backfill (re-runnable: only lines not recorded yet). A line whose stock was already consumed (a SALE movement of
-- its order and variant) gets the cost its variant had at that moment, read from the cost history; a line sold
-- before any cost was known keeps a null cost (unknown). Lines never consumed stay unrecorded.
-- scripts/reports/order-line-cost-report.sql counts what is left unknown.
WITH sold AS (
  SELECT oi.id, oi."variantId", MIN(m."createdAt") AS "soldAt"
  FROM "OrderItem" oi
  JOIN "StockMovement" m
    ON m."refType" = 'Order' AND m."refId" = oi."orderId" AND m."variantId" = oi."variantId" AND m.reason = 'SALE'
  WHERE oi."costRecordedAt" IS NULL
  GROUP BY oi.id, oi."variantId"
)
UPDATE "OrderItem" oi
SET "costRecordedAt" = sold."soldAt",
    "unitCost" = (
      SELECT cc."newValue" FROM "CostChange" cc
      WHERE cc."variantId" = sold."variantId" AND cc."createdAt" <= sold."soldAt"
      ORDER BY cc."createdAt" DESC, cc.id DESC
      LIMIT 1
    )
FROM sold
WHERE oi.id = sold.id;
