/*
  Warnings:

  - A unique constraint covering the columns `[barcode]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "public"."ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."StockStatus" AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER', 'BACKORDER');

-- CreateEnum
CREATE TYPE "public"."Currency" AS ENUM ('GHS', 'USD', 'EUR', 'GBP', 'NGN');

-- CreateEnum
CREATE TYPE "public"."DeliveryOptions" AS ENUM ('LOCAL_DELIVERY', 'INTERNATIONAL_DELIVERY', 'SELECTED_REGIONS');

-- AlterTable
ALTER TABLE "public"."Product" ADD COLUMN     "attachments" TEXT[],
ADD COLUMN     "barcode" TEXT,
ADD COLUMN     "currency" "public"."Currency" DEFAULT 'GHS',
ADD COLUMN     "deliveryOptions" "public"."DeliveryOptions"[] DEFAULT ARRAY['LOCAL_DELIVERY']::"public"."DeliveryOptions"[],
ADD COLUMN     "expiryDate" TIMESTAMP(3),
ADD COLUMN     "isTaxable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lowStockAlert" INTEGER DEFAULT 5,
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "selectedDeliveryRegions" TEXT[],
ADD COLUMN     "shortDescription" VARCHAR(500),
ADD COLUMN     "status" "public"."ProductStatus" DEFAULT 'DRAFT',
ADD COLUMN     "stockStatus" "public"."StockStatus" DEFAULT 'IN_STOCK',
ADD COLUMN     "taxRate" DECIMAL(5,2) DEFAULT 0.00;

-- CreateIndex
CREATE UNIQUE INDEX "Product_barcode_key" ON "public"."Product"("barcode");
