-- Flash sales (P2-B.4): a promotion may cap the units sold at its price across all orders. Expand only, plus a
-- backfill that is safe to re-run.

-- AlterTable
ALTER TABLE "Promotion" ADD COLUMN     "unitCap" INTEGER,
ADD COLUMN     "unitsUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Redemption" ADD COLUMN     "units" INTEGER NOT NULL DEFAULT 0;

-- unitsUsed may exceed unitCap: staff can lower a cap below what was already sold.
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_units_valid" CHECK (
  "unitsUsed" >= 0 AND ("unitCap" IS NULL OR "unitCap" >= 1)
);
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_unit_cap_not_cart" CHECK (NOT ("scope" = 'CART' AND "unitCap" IS NOT NULL));
ALTER TABLE "Redemption" ADD CONSTRAINT "Redemption_units_valid" CHECK ("units" >= 0);

-- Backfill: each existing redemption's units are the quantities of its order's lines the promotion was taken off (item
-- adjustments; a cart promotion has none, so 0), and each promotion's unitsUsed is the sum over its RESERVED
-- redemptions. Both are recomputed from the order snapshot, so a re-run gives the same values.
UPDATE "Redemption" r SET "units" = COALESCE((
  SELECT SUM(oi."quantity")::int
  FROM "OrderAdjustment" a
  JOIN "OrderItem" oi ON oi."id" = a."orderItemId"
  WHERE a."orderId" = r."orderId" AND a."sourceId" = r."promotionId"
), 0);

UPDATE "Promotion" p SET "unitsUsed" = COALESCE((
  SELECT SUM(r."units")::int FROM "Redemption" r WHERE r."promotionId" = p."id" AND r."status" = 'RESERVED'
), 0);
