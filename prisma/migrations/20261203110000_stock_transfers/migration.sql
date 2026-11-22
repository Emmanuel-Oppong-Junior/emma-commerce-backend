-- P4-A.2: two-step stock transfers between locations. Expand only: new tables, nothing existing changes.

-- CreateEnum
CREATE TYPE "StockTransferStatus" AS ENUM ('DRAFT', 'DISPATCHED', 'RECEIVED', 'PARTIALLY_RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "StockTransfer" (
    "id" TEXT NOT NULL,
    "fromLocationId" TEXT NOT NULL,
    "toLocationId" TEXT NOT NULL,
    "status" "StockTransferStatus" NOT NULL DEFAULT 'DRAFT',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "dispatchedById" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "receivedById" TEXT,
    "receivedAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransferLine" (
    "id" TEXT NOT NULL,
    "transferId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "receivedQuantity" INTEGER,
    "varianceNote" TEXT,

    CONSTRAINT "StockTransferLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StockTransfer_status_createdAt_idx" ON "StockTransfer"("status", "createdAt");

-- CreateIndex
CREATE INDEX "StockTransfer_fromLocationId_idx" ON "StockTransfer"("fromLocationId");

-- CreateIndex
CREATE INDEX "StockTransfer_toLocationId_idx" ON "StockTransfer"("toLocationId");

-- CreateIndex
CREATE INDEX "StockTransfer_createdAt_idx" ON "StockTransfer"("createdAt");

-- CreateIndex
CREATE INDEX "StockTransferLine_variantId_idx" ON "StockTransferLine"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "StockTransferLine_transferId_variantId_key" ON "StockTransferLine"("transferId", "variantId");

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_fromLocationId_fkey" FOREIGN KEY ("fromLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toLocationId_fkey" FOREIGN KEY ("toLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_two_locations" CHECK ("fromLocationId" <> "toLocationId");
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "StockTransferLine" ADD CONSTRAINT "StockTransferLine_received_within_quantity"
  CHECK ("receivedQuantity" IS NULL OR ("receivedQuantity" >= 0 AND "receivedQuantity" <= "quantity"));

-- Who may create, dispatch, receive and cancel transfers: the new inventory.transfer permission, granted to the Owner
-- (who holds every permission anyway), the Manager and the Inventory clerk. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.transfer'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK')
  AND NOT ('inventory.transfer' = ANY ("permissions"));
