-- P5-B.1: split shipments. An order may have several shipments, each with ShipmentItem rows (order line, quantity),
-- and a shipment may be CANCELLED before dispatch (its items go back to unshipped). Serial units are picked per shipment
-- line (SerialUnit.shipmentItemId). Existing shipments (one per order) get one item per order line with its full
-- quantity, and units picked for or sold on them point at those items. The backfills are safe to re-run.

-- AlterEnum
ALTER TYPE "ShipmentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "SerialUnit" ADD COLUMN     "shipmentItemId" TEXT;

-- AlterTable
ALTER TABLE "Shipment" ADD COLUMN     "cancelledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShipmentItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipmentItem_orderItemId_idx" ON "ShipmentItem"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentItem_shipmentId_orderItemId_key" ON "ShipmentItem"("shipmentId", "orderItemId");

-- CreateIndex
CREATE INDEX "SerialUnit_shipmentItemId_idx" ON "SerialUnit"("shipmentItemId");

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_shipmentItemId_fkey" FOREIGN KEY ("shipmentItemId") REFERENCES "ShipmentItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentItem" ADD CONSTRAINT "ShipmentItem_quantity_positive" CHECK ("quantity" > 0);

-- The new enum value cannot be used in the transaction that adds it, so the checks compare the status as text.
ALTER TABLE "Shipment" ADD CONSTRAINT "Shipment_cancelled_at_by_status"
  CHECK (("cancelledAt" IS NOT NULL) = ("status"::text = 'CANCELLED'));

-- Backfill: the first shipment of each order carries every order line in full (before P5-B.1 an order had at most
-- one; any later one, which the code never created, stays empty).
INSERT INTO "ShipmentItem" ("id", "shipmentId", "orderItemId", "quantity", "createdAt")
SELECT 'shipment_item_migration_' || gen_random_uuid(), s."id", oi."id", oi."quantity", s."createdAt"
FROM (
  SELECT DISTINCT ON ("orderId") "id", "orderId", "createdAt" FROM "Shipment" ORDER BY "orderId", "createdAt", "id"
) s
JOIN "OrderItem" oi ON oi."orderId" = s."orderId"
WHERE NOT EXISTS (SELECT 1 FROM "ShipmentItem" si WHERE si."shipmentId" = s."id");

-- Backfill: units picked for or sold on an order line belong to that line's item in the order's shipment.
UPDATE "SerialUnit" su SET "shipmentItemId" = si."id"
FROM "ShipmentItem" si
WHERE si."orderItemId" = su."orderItemId" AND su."shipmentItemId" IS NULL AND su."orderItemId" IS NOT NULL;

ALTER TABLE "SerialUnit" ADD CONSTRAINT "SerialUnit_shipment_item_by_status"
  CHECK (("shipmentItemId" IS NOT NULL) = ("status" IN ('ASSIGNED', 'SOLD')));

-- A shipment item is a line of the shipment's own order, and a line's units over its order's non-cancelled shipments
-- never exceed the quantity ordered. The service checks both under the order row lock; this is the backstop.
CREATE FUNCTION "shipment_item_within_order"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ordered INTEGER;
  allocated INTEGER;
BEGIN
  SELECT oi."quantity" INTO ordered
  FROM "OrderItem" oi JOIN "Shipment" s ON s."orderId" = oi."orderId"
  WHERE oi."id" = NEW."orderItemId" AND s."id" = NEW."shipmentId";
  IF ordered IS NULL THEN
    RAISE EXCEPTION 'ShipmentItem: order line % is not on the order of shipment %', NEW."orderItemId", NEW."shipmentId";
  END IF;
  SELECT COALESCE(sum(si."quantity"), 0) INTO allocated
  FROM "ShipmentItem" si JOIN "Shipment" s ON s."id" = si."shipmentId"
  WHERE si."orderItemId" = NEW."orderItemId" AND s."status"::text <> 'CANCELLED' AND si."id" <> NEW."id";
  IF allocated + NEW."quantity" > ordered THEN
    RAISE EXCEPTION 'ShipmentItem: % units of order line % would be in shipments, % ordered',
      allocated + NEW."quantity", NEW."orderItemId", ordered;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ShipmentItem_within_order" BEFORE INSERT OR UPDATE ON "ShipmentItem"
  FOR EACH ROW EXECUTE FUNCTION "shipment_item_within_order"();
