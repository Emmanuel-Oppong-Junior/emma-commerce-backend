-- Delivery slots (P5-A.2): weekly windows per zone with a capacity, per-date closures, a booking count per slot and
-- date, and the booked slot snapshotted on the order. Times are minutes from midnight, Africa/Accra (= UTC).

-- CreateEnum
CREATE TYPE "Weekday" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryDate" DATE,
ADD COLUMN     "deliverySlotId" TEXT,
ADD COLUMN     "deliverySlotReleasedAt" TIMESTAMP(3),
ADD COLUMN     "deliveryWindowEnd" INTEGER,
ADD COLUMN     "deliveryWindowStart" INTEGER;

-- CreateTable
CREATE TABLE "DeliverySlot" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "weekday" "Weekday" NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "cutoffHours" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliverySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverySlotBooking" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "booked" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DeliverySlotBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryClosure" (
    "id" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,

    CONSTRAINT "DeliveryClosure_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeliverySlot_zoneId_idx" ON "DeliverySlot"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliverySlotBooking_slotId_date_key" ON "DeliverySlotBooking"("slotId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryClosure_zoneId_date_key" ON "DeliveryClosure"("zoneId", "date");

-- CreateIndex
CREATE INDEX "Order_deliveryDate_idx" ON "Order"("deliveryDate");

-- AddForeignKey
ALTER TABLE "DeliverySlot" ADD CONSTRAINT "DeliverySlot_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlotBooking" ADD CONSTRAINT "DeliverySlotBooking_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "DeliverySlot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryClosure" ADD CONSTRAINT "DeliveryClosure_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DeliverySlot" ADD CONSTRAINT "DeliverySlot_values_check" CHECK (
  "startMinute" >= 0 AND "endMinute" <= 1440 AND "startMinute" < "endMinute" AND "capacity" > 0 AND "cutoffHours" >= 0
);
-- booked never goes below 0 (a release is conditional) and never above the slot's capacity at booking time (the
-- conditional increment); a capacity lowered later can leave booked above it, which only stops new bookings.
ALTER TABLE "DeliverySlotBooking" ADD CONSTRAINT "DeliverySlotBooking_booked_check" CHECK ("booked" >= 0);
-- An order's slot snapshot is all or nothing.
ALTER TABLE "Order" ADD CONSTRAINT "Order_delivery_slot_check" CHECK (
  ("deliverySlotId" IS NULL AND "deliveryDate" IS NULL AND "deliveryWindowStart" IS NULL AND "deliveryWindowEnd" IS NULL
     AND "deliverySlotReleasedAt" IS NULL)
  OR ("deliverySlotId" IS NOT NULL AND "deliveryDate" IS NOT NULL AND "deliveryWindowStart" IS NOT NULL
     AND "deliveryWindowEnd" IS NOT NULL)
);
