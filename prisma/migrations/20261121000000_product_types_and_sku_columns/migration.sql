-- Catalogue model and SKU columns, expand phase (P1-V.1, ADR-0002 option 4, ADR-0003).
-- Product types own attribute definitions; products get a type, validated JSONB attributes and typed capability
-- columns; variants get the SKU columns. Nothing reads the new variant columns yet: P1-V.2 backfills them.

-- CreateEnum
CREATE TYPE "AttributeDataType" AS ENUM ('TEXT', 'NUMBER', 'BOOLEAN');

-- CreateEnum
CREATE TYPE "FulfilmentKind" AS ENUM ('PHYSICAL', 'DIGITAL', 'SERVICE');

-- CreateEnum
CREATE TYPE "UnitOfMeasure" AS ENUM ('EACH', 'KG', 'G', 'L', 'ML', 'M');

-- CreateTable
CREATE TABLE "ProductType" (
    "id" TEXT NOT NULL,
    "key" VARCHAR(50) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(500),
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeDefinition" (
    "id" TEXT NOT NULL,
    "productTypeId" TEXT NOT NULL,
    "key" VARCHAR(50) NOT NULL,
    "label" VARCHAR(100) NOT NULL,
    "dataType" "AttributeDataType" NOT NULL,
    "unit" VARCHAR(20),
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "allowedValues" TEXT[],
    "isVariantAxis" BOOLEAN NOT NULL DEFAULT false,
    "isFilterable" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttributeDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProductType_key_key" ON "ProductType"("key");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeDefinition_productTypeId_key_key" ON "AttributeDefinition"("productTypeId", "key");

-- AddForeignKey
ALTER TABLE "AttributeDefinition" ADD CONSTRAINT "AttributeDefinition_productTypeId_fkey" FOREIGN KEY ("productTypeId") REFERENCES "ProductType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- System types. General has no attributes and is every existing product's type; Apparel's size and colour axes
-- replace Variant.size/color in P1-V.2. The ids are fixed: Product.productTypeId defaults to General's.
INSERT INTO "ProductType" ("id", "key", "name", "description", "isSystem", "updatedAt") VALUES
  ('product_type_general', 'general', 'General', 'Products without type-specific attributes', true, CURRENT_TIMESTAMP),
  ('product_type_apparel', 'apparel', 'Apparel', 'Clothing and footwear sold in sizes and colours', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "AttributeDefinition"
  ("id", "productTypeId", "key", "label", "dataType", "isRequired", "allowedValues", "isVariantAxis", "isFilterable", "position", "updatedAt")
VALUES
  ('attribute_apparel_size', 'product_type_apparel', 'size', 'Size', 'TEXT', false, ARRAY[]::TEXT[], true, true, 0, CURRENT_TIMESTAMP),
  ('attribute_apparel_colour', 'product_type_apparel', 'colour', 'Colour', 'TEXT', false, ARRAY[]::TEXT[], true, true, 1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "fulfilmentKind" "FulfilmentKind" NOT NULL DEFAULT 'PHYSICAL',
ADD COLUMN     "isPerishable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "productTypeId" TEXT NOT NULL DEFAULT 'product_type_general',
ADD COLUMN     "requiresPrescription" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shelfLifeDays" INTEGER,
ADD COLUMN     "trackLots" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trackSerials" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "unitOfMeasure" "UnitOfMeasure" NOT NULL DEFAULT 'EACH';

-- AlterTable
ALTER TABLE "Variant" ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "basePrice" DECIMAL(14,2),
ADD COLUMN     "heightMm" INTEGER,
ADD COLUMN     "image" TEXT,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lengthMm" INTEGER,
ADD COLUMN     "optionValues" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "optionsKey" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "weightGrams" INTEGER,
ADD COLUMN     "widthMm" INTEGER;

-- CreateIndex
CREATE INDEX "Product_productTypeId_idx" ON "Product"("productTypeId");

-- CreateIndex
CREATE INDEX "Product_attributes_idx" ON "Product" USING GIN ("attributes" jsonb_path_ops);

-- CreateIndex
CREATE UNIQUE INDEX "Variant_sku_key" ON "Variant"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_barcode_key" ON "Variant"("barcode");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_productTypeId_fkey" FOREIGN KEY ("productTypeId") REFERENCES "ProductType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Rules Prisma cannot declare.
ALTER TABLE "Product" ADD CONSTRAINT "Product_shelfLifeDays_positive" CHECK ("shelfLifeDays" IS NULL OR "shelfLifeDays" > 0);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_physical_sizes_positive" CHECK (
  ("weightGrams" IS NULL OR "weightGrams" >= 0) AND ("lengthMm" IS NULL OR "lengthMm" > 0) AND
  ("widthMm" IS NULL OR "widthMm" > 0) AND ("heightMm" IS NULL OR "heightMm" > 0)
);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_basePrice_non_negative" CHECK ("basePrice" IS NULL OR "basePrice" >= 0);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_optionValues_object" CHECK (jsonb_typeof("optionValues") = 'object');
ALTER TABLE "Product" ADD CONSTRAINT "Product_attributes_object" CHECK (jsonb_typeof("attributes") = 'object');
