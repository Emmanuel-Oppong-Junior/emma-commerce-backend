-- B2B price lists per customer group, with a minimum quantity and quantity tiers (P2-W.1, ADR-0005 §7). Expand only:
-- new tables, a nullable OrderItem column and a permission grant, nothing to backfill. CustomerGroup gets no column:
-- lists link to groups through the join table.

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "priceListId" TEXT;

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "currency" "Currency" NOT NULL DEFAULT 'GHS',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "allowPromotions" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListEntry" (
    "id" TEXT NOT NULL,
    "priceListId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "minQuantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceListEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceListTier" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "minQuantity" INTEGER NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PriceListTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CustomerGroupToPriceList" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CustomerGroupToPriceList_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceList_name_key" ON "PriceList"("name");

-- CreateIndex
CREATE INDEX "PriceList_isActive_idx" ON "PriceList"("isActive");

-- CreateIndex
CREATE INDEX "PriceListEntry_variantId_idx" ON "PriceListEntry"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListEntry_priceListId_variantId_key" ON "PriceListEntry"("priceListId", "variantId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceListTier_entryId_minQuantity_key" ON "PriceListTier"("entryId", "minQuantity");

-- CreateIndex
CREATE INDEX "_CustomerGroupToPriceList_B_index" ON "_CustomerGroupToPriceList"("B");

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_priceListId_fkey" FOREIGN KEY ("priceListId") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceListTier" ADD CONSTRAINT "PriceListTier_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "PriceListEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CustomerGroupToPriceList" ADD CONSTRAINT "_CustomerGroupToPriceList_A_fkey" FOREIGN KEY ("A") REFERENCES "CustomerGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CustomerGroupToPriceList" ADD CONSTRAINT "_CustomerGroupToPriceList_B_fkey" FOREIGN KEY ("B") REFERENCES "PriceList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prices are positive, an entry's minimum quantity is at least 1 and a tier's at least 2 (the service also checks that
-- each tier starts above the entry's minimum and that prices never rise going up, which needs the other rows).
ALTER TABLE "PriceListEntry" ADD CONSTRAINT "PriceListEntry_valid" CHECK ("price" > 0 AND "minQuantity" >= 1);
ALTER TABLE "PriceListTier" ADD CONSTRAINT "PriceListTier_valid" CHECK ("price" > 0 AND "minQuantity" >= 2);
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_schedule_valid" CHECK (
  "startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt"
);

-- Who may manage price lists: the new pricelist.manage permission, granted to the Owner (who holds every permission)
-- and the Manager. Safe to re-run.
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'pricelist.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER')
  AND NOT ('pricelist.manage' = ANY ("permissions"));
