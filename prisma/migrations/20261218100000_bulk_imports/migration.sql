-- P8-I: bulk CSV/Excel imports. An ImportJob holds the uploaded file (bytea, cleared once validation has parsed it)
-- and its counts; one ImportRow per data row carries the validation and apply outcome. PRICES imports record
-- PriceChange rows with the new IMPORT source. New permissions: catalog.import (Owner, Manager), inventory.import and
-- catalog.export (Owner, Manager, Inventory clerk). Nothing to backfill.

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('PRODUCTS', 'PRICES', 'STOCK');

-- CreateEnum
CREATE TYPE "ImportFileFormat" AS ENUM ('CSV', 'XLSX');

-- CreateEnum
CREATE TYPE "ImportJobStatus" AS ENUM ('QUEUED', 'VALIDATING', 'VALIDATED', 'APPLYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportRowStatus" AS ENUM ('VALID', 'INVALID', 'APPLIED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportRowAction" AS ENUM ('CREATE', 'UPDATE', 'NONE');

-- AlterEnum (not used in this migration: a value added in a transaction cannot be used in it)
ALTER TYPE "PriceChangeSource" ADD VALUE 'IMPORT';

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "status" "ImportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "format" "ImportFileFormat" NOT NULL,
    "fileName" VARCHAR(255) NOT NULL,
    "sheetName" VARCHAR(100),
    "fileSize" INTEGER NOT NULL,
    "file" BYTEA,
    "applyAfterValidation" BOOLEAN NOT NULL DEFAULT false,
    "applyRuns" INTEGER NOT NULL DEFAULT 0,
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "validRows" INTEGER NOT NULL DEFAULT 0,
    "invalidRows" INTEGER NOT NULL DEFAULT 0,
    "appliedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "failedRows" INTEGER NOT NULL DEFAULT 0,
    "error" VARCHAR(1000),
    "createdById" TEXT NOT NULL,
    "appliedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "validatedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportJob_counts_non_negative" CHECK (
      "fileSize" >= 0 AND "applyRuns" >= 0 AND "totalRows" >= 0 AND "validRows" >= 0 AND "invalidRows" >= 0
      AND "appliedRows" >= 0 AND "skippedRows" >= 0 AND "failedRows" >= 0
    )
);

-- CreateTable
CREATE TABLE "ImportRow" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rowNumber" INTEGER NOT NULL,
    "sku" VARCHAR(255),
    "status" "ImportRowStatus" NOT NULL,
    "action" "ImportRowAction" NOT NULL DEFAULT 'NONE',
    "values" JSONB NOT NULL,
    "errors" TEXT[],
    "warnings" TEXT[],
    "entityId" TEXT,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "ImportRow_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ImportRow_applied_at_iff_applied" CHECK (("status" = 'APPLIED') = ("appliedAt" IS NOT NULL))
);

-- CreateIndex
CREATE INDEX "ImportJob_kind_createdAt_idx" ON "ImportJob"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_status_createdAt_idx" ON "ImportJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ImportRow_jobId_status_idx" ON "ImportRow"("jobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ImportRow_jobId_rowNumber_key" ON "ImportRow"("jobId", "rowNumber");

-- AddForeignKey
ALTER TABLE "ImportRow" ADD CONSTRAINT "ImportRow_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Permissions (re-runnable: each is appended only where missing)
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'catalog.import'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" AND "key" IN ('OWNER', 'MANAGER') AND NOT ('catalog.import' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'catalog.export'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" AND "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK') AND NOT ('catalog.export' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'inventory.import'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "isSystem" AND "key" IN ('OWNER', 'MANAGER', 'INVENTORY_CLERK') AND NOT ('inventory.import' = ANY ("permissions"));
