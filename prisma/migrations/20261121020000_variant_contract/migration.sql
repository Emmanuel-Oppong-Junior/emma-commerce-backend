-- Variant as SKU, contract phase (P1-V.3, ADR-0003). Cart lines, order lines and stock movements now require a
-- variant; Product price, stock, SKU and barcode columns and Variant.size/color are dropped: the application reads
-- only the variant since this release. 20261121010000_default_variants backfilled everything this relies on and
-- reported what it could not map (scripts/reports/variant-migration-report.sql); it ships in the same release.

-- Fail fast instead of dropping data the backfill did not anchor.
DO $$
DECLARE
  unanchored bigint;
BEGIN
  SELECT (SELECT count(*) FROM "CartItem" WHERE "variantId" IS NULL)
       + (SELECT count(*) FROM "OrderItem" WHERE "variantId" IS NULL)
       + (SELECT count(*) FROM "InventoryLog" WHERE "variantId" IS NULL)
  INTO unanchored;
  IF unanchored > 0 THEN
    RAISE EXCEPTION '% cart line(s), order line(s) or stock movement(s) have no variant; run the default_variants backfill first', unanchored;
  END IF;
END $$;

-- DropForeignKey
ALTER TABLE "InventoryLog" DROP CONSTRAINT "InventoryLog_variantId_fkey";

-- DropForeignKey
ALTER TABLE "Variant" DROP CONSTRAINT "Variant_productId_fkey";

-- DropIndex
DROP INDEX "CartItem_cartId_productId_idx";

-- DropIndex
DROP INDEX "Product_barcode_key";

-- DropIndex
DROP INDEX "Product_sku_key";

-- AlterTable
ALTER TABLE "CartItem" ALTER COLUMN "variantId" SET NOT NULL;

-- AlterTable
ALTER TABLE "InventoryLog" ALTER COLUMN "variantId" SET NOT NULL;

-- AlterTable: lines ordered before this release keep NULL snapshots (they were never recorded).
ALTER TABLE "OrderItem" ADD COLUMN     "optionValues" JSONB,
ADD COLUMN     "sku" TEXT,
ALTER COLUMN "variantId" SET NOT NULL;

-- AlterTable (drops the Product_quantity_non_negative check with its column)
ALTER TABLE "Product" DROP COLUMN "barcode",
DROP COLUMN "basePrice",
DROP COLUMN "currentPrice",
DROP COLUMN "lowStockAlert",
DROP COLUMN "price",
DROP COLUMN "quantity",
DROP COLUMN "sku",
DROP COLUMN "stockStatus";

-- AlterTable
ALTER TABLE "Variant" DROP COLUMN "color",
DROP COLUMN "size";

-- DropEnum
DROP TYPE "StockStatus";

-- CreateIndex
CREATE INDEX "CartItem_cartId_variantId_idx" ON "CartItem"("cartId", "variantId");

-- AddForeignKey: deleting a product deletes its variants (permanentlyDeleteProduct refuses one with carts or orders).
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLog" ADD CONSTRAINT "InventoryLog_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
