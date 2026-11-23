-- P4-D.1: serial units (IMEI). Opt-in per product with the existing Product.trackSerials flag, plus a serial format
-- and an optional warranty length. One SerialUnit per physical unit of a tracked variant, with an append-only
-- SerialUnitEvent history. Expand-only: existing products stay untracked (trackSerials defaults to false), so there is
-- nothing to backfill.
CREATE TYPE "SerialFormat" AS ENUM ('FREE_TEXT', 'IMEI');

-- CreateEnum
CREATE TYPE "SerialUnitStatus" AS ENUM ('IN_STOCK', 'ASSIGNED', 'SOLD', 'IN_TRANSIT', 'WRITTEN_OFF');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "serialFormat" "SerialFormat" NOT NULL DEFAULT 'FREE_TEXT',
ADD COLUMN     "warrantyMonths" INTEGER;

-- CreateTable
CREATE TABLE "SerialUnit" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "serial" TEXT NOT NULL,
    "status" "SerialUnitStatus" NOT NULL DEFAULT 'IN_STOCK',
    "locationId" TEXT,
    "orderItemId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soldAt" TIMESTAMP(3),
    "warrantyStartsAt" TIMESTAMP(3),
    "warrantyEndsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SerialUnit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SerialUnitEvent" (
    "id" TEXT NOT NULL,
    "serialUnitId" TEXT NOT NULL,
    "from" "SerialUnitStatus",
    "to" "SerialUnitStatus" NOT NULL,
    "locationId" TEXT,
    "orderItemId" TEXT,
    "movementId" TEXT,
    "refType" TEXT,
    "refId" TEXT,
    "actorId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SerialUnitEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SerialUnit_serial_idx" ON "SerialUnit"("serial");

-- CreateIndex
CREATE INDEX "SerialUnit_orderItemId_idx" ON "SerialUnit"("orderItemId");

-- CreateIndex
CREATE INDEX "SerialUnit_variantId_locationId_status_idx" ON "SerialUnit"("variantId", "locationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SerialUnit_variantId_serial_key" ON "SerialUnit"("variantId", "serial");

-- CreateIndex
CREATE INDEX "SerialUnitEvent_serialUnitId_createdAt_idx" ON "SerialUnitEvent"("serialUnitId", "createdAt");

-- CreateIndex
CREATE INDEX "SerialUnitEvent_refType_refId_idx" ON "SerialUnitEvent"("refType", "refId");

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnitEvent" ADD CONSTRAINT "SerialUnitEvent_serialUnitId_fkey" FOREIGN KEY ("serialUnitId") REFERENCES "SerialUnit"("id") ON DELETE CASCADE ON UPDATE CASCADE;


ALTER TABLE "Product" ADD CONSTRAINT "Product_warrantyMonths_range"
  CHECK ("warrantyMonths" IS NULL OR "warrantyMonths" BETWEEN 1 AND 120);

-- Where a unit is follows from its status: on a shelf while IN_STOCK or ASSIGNED, tied to an order line while ASSIGNED
-- or SOLD, sold (and only then possibly under warranty) while SOLD.
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_location_by_status"
  CHECK (("locationId" IS NOT NULL) = ("status" IN ('IN_STOCK', 'ASSIGNED')));
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_order_item_by_status"
  CHECK (("orderItemId" IS NOT NULL) = ("status" IN ('ASSIGNED', 'SOLD')));
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_sold_at_by_status"
  CHECK (("soldAt" IS NOT NULL) = ("status" = 'SOLD'));
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_warranty"
  CHECK (
    ("warrantyStartsAt" IS NULL) = ("warrantyEndsAt" IS NULL)
    AND ("warrantyStartsAt" IS NULL OR ("status" = 'SOLD' AND "warrantyEndsAt" > "warrantyStartsAt"))
  );
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_serial_length"
  CHECK (char_length("serial") BETWEEN 1 AND 64);

-- The history is append-only. Deleting a variant (or its product) still removes its units and their events: those
-- deletes run inside the foreign-key cascade trigger, one trigger level deeper than a direct DELETE.
CREATE FUNCTION "serial_unit_event_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'SerialUnitEvent is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "SerialUnitEvent_append_only" BEFORE UPDATE OR DELETE ON "SerialUnitEvent"
  FOR EACH ROW EXECUTE FUNCTION "serial_unit_event_append_only"();
