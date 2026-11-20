-- Reconciliation report of the variant (SKU) migration, P1-V.2 (prisma/migrations/20261121010000_default_variants).
-- Read-only and safe to re-run. It reads the rows the migration wrote to "AuditLog" (entity 'VariantMigration'):
-- ids of products and variants, quantities and prices only, no personal data.
--   psql "$DATABASE_URL" -f scripts/reports/variant-migration-report.sql
--
-- Actions:
--   PRODUCT_STOCK_PRICE_DROPPED    product with variants: its product-level quantity/price/basePrice were not kept
--                                  (the variants' own stock and prices were); compare with variantQuantity
--   SWITCHED_TO_APPAREL            product whose variants had size/color: now type Apparel, options size/colour
--   OPTIONS_NOT_MAPPED             variant whose size/color could not become option values; archived
--   DUPLICATE_OPTIONS_ARCHIVED     variant with the same option combination as an older active one; archived
--   MISSING_BASE_PRICE             variant of a taxable product with no basePrice; set one (price is not re-derived)
--   DEFAULT_VARIANT_WITHOUT_PRICE  product had no price; its default variant is archived until a price is set
--   LEGACY_VARIANT_CREATED         archived zero-stock variant holding cart/order lines and stock movements that
--                                  pointed only at a product with variants

SELECT action, count(*) AS rows
FROM "AuditLog"
WHERE entity = 'VariantMigration'
GROUP BY action
ORDER BY action;

SELECT action, "entityId" AS "productId", details
FROM "AuditLog"
WHERE entity = 'VariantMigration'
ORDER BY action, "entityId", id;
