-- P4-B.1: every manual adjustment names a reason from a fixed list; a stock-take posts its variances as STOCK_TAKE.
-- No backfill: adjustments recorded before keep adjustmentReason null (their free-text reason stays in "note").

-- CreateEnum
CREATE TYPE "StockAdjustmentReason" AS ENUM ('DAMAGED', 'LOST', 'FOUND', 'EXPIRED', 'CORRECTION', 'STOCK_TAKE', 'OTHER');

-- AlterTable
ALTER TABLE "StockMovement" ADD COLUMN     "adjustmentReason" "StockAdjustmentReason";

ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_adjustment_reason_only_on_adjustments"
  CHECK ("adjustmentReason" IS NULL OR "reason" = 'ADJUSTMENT');
-- OTHER says nothing on its own, so it must come with a note.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_other_adjustment_note"
  CHECK ("adjustmentReason" IS DISTINCT FROM 'OTHER' OR btrim(COALESCE("note", '')) <> '');
