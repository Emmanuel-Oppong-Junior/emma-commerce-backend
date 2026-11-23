-- P5-C.1: riders. A system Rider staff role holding only delivery.ride, and the rider assigned to a shipment
-- (delivery orders only, checked by the application) with the time of assignment. The role insert is safe to re-run.

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "riderId" TEXT;

-- CreateIndex
CREATE INDEX "Shipment_riderId_status_idx" ON "Shipment"("riderId", "status");

-- AddForeignKey
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_riderId_fkey" FOREIGN KEY ("riderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_rider_assigned_at"
  CHECK (("riderId" IS NULL) = ("assignedAt" IS NULL));

-- Riders work from a phone on their own assigned shipments only, so the role does not require MFA.
INSERT INTO "StaffRole" ("id", "key", "name", "permissions", "isSystem", "mfaRequired", "updatedAt") VALUES
  ('staff_role_rider', 'RIDER', 'Rider', ARRAY['delivery.ride']::TEXT[], true, false, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

-- The Owner row lists every permission (the application grants it any permission anyway); it is never a rider.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'delivery.ride'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" = 'OWNER' AND NOT ('delivery.ride' = ANY ("permissions"));
