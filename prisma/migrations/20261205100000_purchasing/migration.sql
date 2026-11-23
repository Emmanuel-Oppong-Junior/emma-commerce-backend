-- P4-E.1: suppliers, purchase orders with receipts, and the weighted-average cost of each variant. Expand only: new
-- tables and nullable columns; existing variants keep costPrice NULL (unknown), existing movements unitCost NULL.

-- CreateEnum
CREATE TYPE "PurchaseOrderStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CostChangeSource" AS ENUM ('PURCHASE_ORDER', 'MANUAL');

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "unitCost" DECIMAL(14,4);

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "costPrice" DECIMAL(14,4);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "nameKey" VARCHAR(200) NOT NULL,
    "contactName" VARCHAR(200),
    "phone" VARCHAR(50),
    "email" VARCHAR(320),
    "address" VARCHAR(1000),
    "notes" VARCHAR(2000),
    "currency" "Currency" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "supplierId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "status" "PurchaseOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" "Currency" NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "note" VARCHAR(1000),
    "createdById" TEXT NOT NULL,
    "sentById" TEXT,
    "sentAt" TIMESTAMP(3),
    "closedById" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" VARCHAR(500),
    "cancelledById" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" VARCHAR(500),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderLine" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "quantityOrdered" INTEGER NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PurchaseOrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderReceipt" (
    "id" TEXT NOT NULL,
    "purchaseOrderId" TEXT NOT NULL,
    "receivedById" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" VARCHAR(500),

    CONSTRAINT "PurchaseOrderReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PurchaseOrderReceiptLine" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "lotId" TEXT,
    "movementId" TEXT NOT NULL,

    CONSTRAINT "PurchaseOrderReceiptLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostChange" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "oldValue" DECIMAL(14,4),
    "newValue" DECIMAL(14,4) NOT NULL,
    "currency" "Currency" NOT NULL,
    "source" "CostChangeSource" NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "reason" VARCHAR(500),
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_storeId_nameKey_key" ON "Supplier"("storeId", "nameKey");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrder_number_key" ON "PurchaseOrder"("number");

-- CreateIndex
CREATE INDEX "PurchaseOrder_status_createdAt_idx" ON "PurchaseOrder"("status", "createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrder_supplierId_idx" ON "PurchaseOrder"("supplierId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_locationId_idx" ON "PurchaseOrder"("locationId");

-- CreateIndex
CREATE INDEX "PurchaseOrder_createdAt_idx" ON "PurchaseOrder"("createdAt");

-- CreateIndex
CREATE INDEX "PurchaseOrderLine_variantId_idx" ON "PurchaseOrderLine"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderLine_purchaseOrderId_variantId_key" ON "PurchaseOrderLine"("purchaseOrderId", "variantId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceipt_purchaseOrderId_idx" ON "PurchaseOrderReceipt"("purchaseOrderId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_lineId_idx" ON "PurchaseOrderReceiptLine"("lineId");

-- CreateIndex
CREATE INDEX "PurchaseOrderReceiptLine_lotId_idx" ON "PurchaseOrderReceiptLine"("lotId");

-- CreateIndex
CREATE UNIQUE INDEX "PurchaseOrderReceiptLine_receiptId_lineId_key" ON "PurchaseOrderReceiptLine"("receiptId", "lineId");

-- CreateIndex
CREATE INDEX "CostChange_variantId_createdAt_idx" ON "CostChange"("variantId", "createdAt");

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceipt" ADD CONSTRAINT "PurchaseOrderReceipt_purchaseOrderId_fkey" FOREIGN KEY ("purchaseOrderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "PurchaseOrderReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "PurchaseOrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostChange" ADD CONSTRAINT "CostChange_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Quantities and costs can never go out of range, whatever writes them.
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_quantity_positive" CHECK ("quantityOrdered" > 0);
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_received_within_ordered"
  CHECK ("quantityReceived" >= 0 AND "quantityReceived" <= "quantityOrdered");
ALTER TABLE "PurchaseOrderLine" ADD CONSTRAINT "PurchaseOrderLine_unit_cost_not_negative" CHECK ("unitCost" >= 0);
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "PurchaseOrderReceiptLine" ADD CONSTRAINT "PurchaseOrderReceiptLine_unit_cost_not_negative"
  CHECK ("unitCost" >= 0);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_cost_price_not_negative" CHECK ("costPrice" IS NULL OR "costPrice" >= 0);
ALTER TABLE "CostChange" ADD CONSTRAINT "CostChange_values_not_negative"
  CHECK ("newValue" >= 0 AND ("oldValue" IS NULL OR "oldValue" >= 0));

-- A unit cost belongs to goods bought in: only RECEIPT movements carry one.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_unit_cost_on_receipt"
  CHECK ("unitCost" IS NULL OR ("reason" = 'RECEIPT' AND "unitCost" >= 0));

-- Each status carries who moved the purchase order there and when (a cancelled one may have been sent first).
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_status_stamps"
  CHECK (
    ("status" IN ('DRAFT', 'CANCELLED') OR ("sentAt" IS NOT NULL AND "sentById" IS NOT NULL))
    AND ("status" <> 'DRAFT' OR ("sentAt" IS NULL AND "sentById" IS NULL))
    AND ("status" = 'CLOSED') = ("closedAt" IS NOT NULL AND "closedById" IS NOT NULL)
    AND ("status" = 'CANCELLED') = ("cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL)
  );

-- Cost history is append-only, like PriceChange: rows only go when their variant is deleted (a cascade, so the
-- trigger depth is above 1).
CREATE FUNCTION "cost_change_append_only"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'CostChange is append-only: % refused', TG_OP;
END $$;
CREATE TRIGGER "CostChange_append_only" BEFORE UPDATE OR DELETE ON "CostChange"
  FOR EACH ROW EXECUTE FUNCTION "cost_change_append_only"();

-- New permissions. purchasing.view (suppliers and purchase orders, costs hidden) and purchasing.receive (receive
-- deliveries) go to the Owner, the Manager and the Inventory clerk; purchasing.manage (suppliers, purchase orders,
-- manual costs) and inventory.cost.view (costs) to the Owner and the Manager. The Owner holds every permission anyway.
-- Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'purchasing.view'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK')
  AND NOT ('purchasing.view' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'purchasing.receive'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK')
  AND NOT ('purchasing.receive' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'purchasing.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('purchasing.manage' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.cost.view'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('inventory.cost.view' = ANY ("permissions"));
