-- P4-B.2: low-stock alerts waiting for the staff digest (one pending per variant and location) and the new
-- inventory.alerts permission. No backfill: alerts start with the next low-stock event.

-- CreateEnum
CREATE TYPE "LowStockAlertStatus" AS ENUM ('PENDING', 'SENT', 'DROPPED');

-- CreateTable
CREATE TABLE "LowStockAlert" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "availableAtAlert" INTEGER NOT NULL,
    "status" "LowStockAlertStatus" NOT NULL DEFAULT 'PENDING',
    "digestId" TEXT,
    "availableAtDigest" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "LowStockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LowStockAlert_eventId_key" ON "LowStockAlert"("eventId");

-- CreateIndex
CREATE INDEX "LowStockAlert_status_createdAt_idx" ON "LowStockAlert"("status", "createdAt");

-- CreateIndex
CREATE INDEX "LowStockAlert_digestId_idx" ON "LowStockAlert"("digestId");

-- CreateIndex
CREATE INDEX "LowStockAlert_locationId_idx" ON "LowStockAlert"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "LowStockAlert_one_pending_per_variant_location" ON "LowStockAlert"("variantId", "locationId") WHERE (status = 'PENDING'::"LowStockAlertStatus");

-- AddForeignKey
ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A pending alert is open; a sent one names its digest and the stock it showed.
ALTER TABLE "LowStockAlert" ADD CONSTRAINT "LowStockAlert_resolution"
  CHECK (
    ("status" = 'PENDING') = ("resolvedAt" IS NULL)
    AND ("status" = 'SENT') = ("digestId" IS NOT NULL AND "availableAtDigest" IS NOT NULL)
  );

-- Who receives the low-stock digest: the new inventory.alerts permission, granted to the Owner (who holds every
-- permission anyway), the Manager and the Inventory clerk, who restock. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.alerts'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK')
  AND NOT ('inventory.alerts' = ANY ("permissions"));
