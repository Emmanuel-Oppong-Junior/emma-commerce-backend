-- P4-C.1: lots with expiry for products with trackLots (opt-in, default off). A Lot belongs to one variant (lot number
-- unique per variant); LotStock holds its units per location; every on-hand movement of a lot-tracked variant names
-- its lot. Expand-only: existing products stay untracked and existing movements keep lotId null, so nothing is
-- backfilled.

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "lotId" TEXT;

-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "lotNumber" VARCHAR(100) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "manufacturedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotStock" (
    "id" TEXT NOT NULL,
    "lotId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "onHand" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LotStock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lot_expiresAt_idx" ON "Lot"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Lot_variantId_lotNumber_key" ON "Lot"("variantId", "lotNumber");

-- CreateIndex
CREATE INDEX "LotStock_locationId_idx" ON "LotStock"("locationId");

-- CreateIndex
CREATE UNIQUE INDEX "LotStock_lotId_locationId_key" ON "LotStock"("lotId", "locationId");

-- CreateIndex
CREATE INDEX "StockMovement_lotId_idx" ON "StockMovement"("lotId");

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotStock" ADD CONSTRAINT "LotStock_lotId_fkey" FOREIGN KEY ("lotId") REFERENCES "Lot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotStock" ADD CONSTRAINT "LotStock_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "StockLocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The ledger never takes a lot below zero (conditional updates); the database refuses it as a last line.
ALTER TABLE "LotStock" ADD CONSTRAINT "LotStock_onHand_non_negative" CHECK ("onHand" >= 0);
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_lot_number_not_blank" CHECK (btrim("lotNumber") <> '');
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_manufactured_before_expiry"
  CHECK ("manufacturedAt" IS NULL OR "manufacturedAt" < "expiresAt");
-- Reservations stay per variant and location (lots are drawn when the sale is consumed), so a lot only ever goes with
-- a change of on-hand stock.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_lot_only_on_on_hand_changes"
  CHECK ("lotId" IS NULL OR ("onHandDelta" <> 0 AND "reason" NOT IN ('RESERVE', 'RELEASE')));

