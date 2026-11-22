-- P4-B.1: stock-takes. A count session at one location with one line per variant; approval posts each non-zero
-- variance as an ADJUSTMENT (STOCK_TAKE). New permission inventory.stocktake.approve. No backfill.

-- CreateEnum
CREATE TYPE "StockTakeStatus" AS ENUM ('OPEN', 'SUBMITTED', 'APPROVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StockTake" (
    "id" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "StockTakeStatus" NOT NULL DEFAULT 'OPEN',
    "categoryId" TEXT,
    "note" TEXT,
    "openedById" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedById" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTake_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTakeLine" (
    "id" TEXT NOT NULL,
    "stockTakeId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "expectedAtOpen" INTEGER NOT NULL,
    "expectedQuantity" INTEGER,
    "countedQuantity" INTEGER,
    "variance" INTEGER,
    "countedById" TEXT,
    "countedAt" TIMESTAMP(3),
    "movementId" TEXT,

    CONSTRAINT "StockTakeLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockTake_status_openedAt_idx" ON "StockTake"("status", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "StockTake_one_open_per_location" ON "StockTake"("locationId") WHERE (status = ANY (ARRAY['OPEN'::"StockTakeStatus", 'SUBMITTED'::"StockTakeStatus"]));

-- CreateIndex
CREATE INDEX "StockTakeLine_variantId_idx" ON "StockTakeLine"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTakeLine_stockTakeId_variantId_key" ON "StockTakeLine"("stockTakeId", "variantId");

-- AddForeignKey
ALTER TABLE "StockTake" ADD CONSTRAINT "StockTake_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_stockTakeId_fkey" FOREIGN KEY ("stockTakeId") REFERENCES "StockTake"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A line is counted all at once: count, expected quantity at the count, variance and time are set together.
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_count_complete"
  CHECK (
    ("countedQuantity" IS NULL) = ("expectedQuantity" IS NULL)
    AND ("countedQuantity" IS NULL) = ("variance" IS NULL)
    AND ("countedQuantity" IS NULL) = ("countedAt" IS NULL)
  );
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_quantities_not_negative"
  CHECK ("expectedAtOpen" >= 0 AND "expectedQuantity" >= 0 AND "countedQuantity" >= 0);
ALTER TABLE "StockTakeLine" ADD CONSTRAINT "StockTakeLine_variance"
  CHECK ("variance" = "countedQuantity" - "expectedQuantity");

-- Each status carries who moved the session there and when (a cancelled session may have been submitted first).
ALTER TABLE "StockTake" ADD CONSTRAINT "StockTake_status_stamps"
  CHECK (
    ("status" NOT IN ('SUBMITTED', 'APPROVED') OR ("submittedAt" IS NOT NULL AND "submittedById" IS NOT NULL))
    AND ("status" <> 'OPEN' OR ("submittedAt" IS NULL AND "submittedById" IS NULL))
    AND ("status" = 'APPROVED') = ("approvedAt" IS NOT NULL AND "approvedById" IS NOT NULL)
    AND ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL)
  );

-- Who may approve stock-take variances into stock or cancel a stock-take: the new inventory.stocktake.approve
-- permission, granted to the Owner (who holds every permission anyway) and the Manager. Counting stays under
-- inventory.adjust. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.stocktake.approve'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('inventory.stocktake.approve' = ANY ("permissions"));
