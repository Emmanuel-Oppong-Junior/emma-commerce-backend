-- P6-G.3: recently viewed products of signed-in users, one row per (user, product); the service keeps the latest 20 per
-- user (upsert and prune in one transaction). New table only, nothing to backfill.

-- CreateTable
CREATE TABLE "RecentlyViewedProduct" (
    "userId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecentlyViewedProduct_pkey" PRIMARY KEY ("userId","productId")
);

-- CreateIndex
CREATE INDEX "RecentlyViewedProduct_userId_viewedAt_idx" ON "RecentlyViewedProduct"("userId", "viewedAt");

-- CreateIndex
CREATE INDEX "RecentlyViewedProduct_productId_idx" ON "RecentlyViewedProduct"("productId");

-- AddForeignKey
ALTER TABLE "RecentlyViewedProduct" ADD CONSTRAINT "RecentlyViewedProduct_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecentlyViewedProduct" ADD CONSTRAINT "RecentlyViewedProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
