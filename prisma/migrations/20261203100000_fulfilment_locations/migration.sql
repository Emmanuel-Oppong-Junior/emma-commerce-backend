-- P4-A.1: stock locations fulfil orders by rule. Expand only: existing orders, stock and reservations stay at the
-- store's default location, and an empty fulfilment list means that default, so behaviour is unchanged.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stockLocationId" TEXT;

-- CreateTable
CREATE TABLE "ShippingZoneStockLocation" (
    "shippingZoneId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,

    CONSTRAINT "ShippingZoneStockLocation_pkey" PRIMARY KEY ("shippingZoneId","locationId")
);

-- CreateTable
CREATE TABLE "PickupLocationStockLocation" (
    "pickupLocationId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,

    CONSTRAINT "PickupLocationStockLocation_pkey" PRIMARY KEY ("pickupLocationId","locationId")
);

-- CreateIndex
CREATE INDEX "ShippingZoneStockLocation_locationId_idx" ON "ShippingZoneStockLocation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "ShippingZoneStockLocation_shippingZoneId_priority_key" ON "ShippingZoneStockLocation"("shippingZoneId", "priority");

-- CreateIndex
CREATE INDEX "PickupLocationStockLocation_locationId_idx" ON "PickupLocationStockLocation"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "PickupLocationStockLocation_pickupLocationId_priority_key" ON "PickupLocationStockLocation"("pickupLocationId", "priority");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_stockLocationId_fkey" FOREIGN KEY ("stockLocationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingZoneStockLocation" ADD CONSTRAINT "ShippingZoneStockLocation_shippingZoneId_fkey" FOREIGN KEY ("shippingZoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingZoneStockLocation" ADD CONSTRAINT "ShippingZoneStockLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupLocationStockLocation" ADD CONSTRAINT "PickupLocationStockLocation_pickupLocationId_fkey" FOREIGN KEY ("pickupLocationId") REFERENCES "PickupLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PickupLocationStockLocation" ADD CONSTRAINT "PickupLocationStockLocation_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShippingZoneStockLocation" ADD CONSTRAINT "ShippingZoneStockLocation_priority_non_negative" CHECK ("priority" >= 0);
ALTER TABLE "PickupLocationStockLocation" ADD CONSTRAINT "PickupLocationStockLocation_priority_non_negative" CHECK ("priority" >= 0);

-- The default location is where empty fulfilment lists send orders, so it can never be inactive.
ALTER TABLE "StockLocation" ADD CONSTRAINT "StockLocation_default_is_active" CHECK (NOT "isDefault" OR "isActive");

-- Existing orders were reserved at the default location: record where each order's reservations are. Safe to re-run.
UPDATE "Order" o
SET "stockLocationId" = r."locationId"
FROM (SELECT "orderId", min("locationId") AS "locationId" FROM "StockReservation" GROUP BY "orderId") r
WHERE r."orderId" = o."id" AND o."stockLocationId" IS NULL;

-- Who may manage locations and fulfilment lists: the new inventory.location.manage permission, granted to the Owner
-- (who holds every permission anyway) and the Manager. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.location.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('inventory.location.manage' = ANY ("permissions"));
