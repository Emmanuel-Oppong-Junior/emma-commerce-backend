-- Prisma cannot declare CHECK constraints. This fails if any row already holds negative stock:
-- fix those rows (with an inventory log entry) before deploying.
ALTER TABLE "Product" ADD CONSTRAINT "Product_quantity_non_negative" CHECK ("quantity" >= 0);
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_quantity_non_negative" CHECK ("quantity" >= 0);
