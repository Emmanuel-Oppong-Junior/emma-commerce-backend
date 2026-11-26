-- P8-C contract: the backfilled slugs become plainly unique (the Prisma @unique indexes) and must be well formed, so an
-- empty slug left by an unfinished backfill makes this migration fail instead of passing silently.
DROP INDEX "Product_slug_backfill_key";
DROP INDEX "Category_slug_backfill_key";
DROP INDEX "SubCategory_slug_backfill_key";
DROP INDEX "Brand_slug_backfill_key";

-- CreateIndex
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SubCategory_slug_key" ON "SubCategory"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Brand_slug_key" ON "Brand"("slug");

ALTER TABLE "Product" ADD CONSTRAINT "Product_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "Category" ADD CONSTRAINT "Category_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "SubCategory" ADD CONSTRAINT "SubCategory_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "Brand" ADD CONSTRAINT "Brand_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
