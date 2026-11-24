-- P6-V.1: verified-purchase reviews, one per customer and product, moderation (hide/unhide, reports), photos, a store
-- reply and the product rating kept on Product. Deletes are hard from now on, so the soft-delete columns (never written)
-- go: rows marked deleted are removed first, then duplicates per (user, product) keep the latest. Both steps and the
-- rating backfill are safe to re-run; the counts removed are printed as NOTICEs.

DO $$
DECLARE
  removed_deleted INTEGER;
  removed_duplicates INTEGER;
BEGIN
  DELETE FROM "Review" WHERE "deleted";
  GET DIAGNOSTICS removed_deleted = ROW_COUNT;
  WITH ranked AS (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "productId" ORDER BY "createdAt" DESC, "id" DESC) AS rn
    FROM "Review"
  )
  DELETE FROM "Review" r USING ranked WHERE r."id" = ranked."id" AND ranked.rn > 1;
  GET DIAGNOSTICS removed_duplicates = ROW_COUNT;
  RAISE NOTICE 'P6-V.1 reviews: % soft-deleted removed, % duplicates removed', removed_deleted, removed_duplicates;
END $$;

-- CreateEnum
CREATE TYPE "ModerationStatus" AS ENUM ('PUBLISHED', 'HIDDEN');

-- CreateEnum
CREATE TYPE "ContentReportReason" AS ENUM ('SPAM', 'OFFENSIVE', 'OFF_TOPIC', 'FAKE', 'PERSONAL_INFORMATION', 'OTHER');

-- DropIndex
DROP INDEX "Review_productId_idx";

-- DropIndex
DROP INDEX "Review_userId_idx";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "rating1Count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating2Count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating3Count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating4Count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rating5Count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ratingAverage" DECIMAL(3,2),
ADD COLUMN     "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Review" DROP COLUMN "deleted",
DROP COLUMN "deletedAt",
ADD COLUMN     "editedAt" TIMESTAMP(3),
ADD COLUMN     "hiddenAt" TIMESTAMP(3),
ADD COLUMN     "hiddenReason" TEXT,
ADD COLUMN     "orderItemId" TEXT,
ADD COLUMN     "repliedAt" TIMESTAMP(3),
ADD COLUMN     "reply" TEXT,
ADD COLUMN     "status" "ModerationStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN     "title" VARCHAR(120),
ADD COLUMN     "verifiedPurchase" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ReviewPhoto" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewPhoto_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewReport" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" "ContentReportReason" NOT NULL,
    "note" VARCHAR(500),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewPhoto_reviewId_idx" ON "ReviewPhoto"("reviewId");

-- CreateIndex
CREATE INDEX "ReviewReport_reporterId_idx" ON "ReviewReport"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewReport_reviewId_reporterId_key" ON "ReviewReport"("reviewId", "reporterId");

-- CreateIndex
CREATE INDEX "Review_productId_status_createdAt_idx" ON "Review"("productId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Review_orderItemId_idx" ON "Review"("orderItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_userId_productId_key" ON "Review"("userId", "productId");

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewPhoto" ADD CONSTRAINT "ReviewPhoto_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewReport" ADD CONSTRAINT "ReviewReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Review" ADD CONSTRAINT "Review_score_range" CHECK ("score" BETWEEN 1 AND 5);
ALTER TABLE "Review" ADD CONSTRAINT "Review_hidden"
  CHECK (("status" = 'HIDDEN') = ("hiddenAt" IS NOT NULL AND "hiddenReason" IS NOT NULL));
ALTER TABLE "Review" ADD CONSTRAINT "Review_reply" CHECK (("reply" IS NULL) = ("repliedAt" IS NULL));

ALTER TABLE "Product" ADD CONSTRAINT "Product_rating"
  CHECK (
    LEAST("rating1Count", "rating2Count", "rating3Count", "rating4Count", "rating5Count") >= 0
    AND "ratingCount" = "rating1Count" + "rating2Count" + "rating3Count" + "rating4Count" + "rating5Count"
    AND ("ratingCount" = 0) = ("ratingAverage" IS NULL)
  );

-- Backfill (re-runnable: recomputed from the published reviews)
UPDATE "Product" p SET
  "rating1Count" = COALESCE(r.c1, 0), "rating2Count" = COALESCE(r.c2, 0), "rating3Count" = COALESCE(r.c3, 0),
  "rating4Count" = COALESCE(r.c4, 0), "rating5Count" = COALESCE(r.c5, 0), "ratingCount" = COALESCE(r.n, 0),
  "ratingAverage" = CASE WHEN COALESCE(r.n, 0) = 0 THEN NULL ELSE ROUND(r.total::NUMERIC / r.n, 2) END
FROM "Product" p2
LEFT JOIN (
  SELECT "productId",
    COUNT(*) FILTER (WHERE "score" = 1) AS c1, COUNT(*) FILTER (WHERE "score" = 2) AS c2,
    COUNT(*) FILTER (WHERE "score" = 3) AS c3, COUNT(*) FILTER (WHERE "score" = 4) AS c4,
    COUNT(*) FILTER (WHERE "score" = 5) AS c5, COUNT(*) AS n, SUM("score") AS total
  FROM "Review" WHERE "status" = 'PUBLISHED' GROUP BY "productId"
) r ON r."productId" = p2."id"
WHERE p."id" = p2."id";
