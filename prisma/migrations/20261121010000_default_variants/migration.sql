-- Every product sells through variants (P1-V.2, ADR-0003, ROADMAP migration rule 7). Backfill, safe to re-run:
--   * a product without variants gets one default variant (id "<productId>_default") copying its price, basePrice,
--     stock, SKU and barcode;
--   * a product with variants keeps their stock and prices; its product-level stock and price are reported, not moved;
--   * Variant.size/color become Apparel option values (the product switches from General to Apparel);
--   * active variants sharing an option combination: the oldest stays active, the others are archived and reported;
--   * cart lines, order lines and stock movements that point only at a product that has variants are anchored on an
--     archived zero-stock "Legacy" variant (id "<productId>_legacy"); those of other products on the default variant.
-- Rows that cannot be mapped deterministically are reported, never guessed. The report is written to "AuditLog"
-- (entity 'VariantMigration', userId NULL, no personal data) and summarised with RAISE NOTICE; read it with
-- scripts/reports/variant-migration-report.sql. Variant.size/color and Product price/stock columns are dropped later
-- (20261121020000_variant_contract), once nothing reads them.

ALTER TABLE "Variant" ALTER COLUMN "price" DROP NOT NULL;

CREATE TEMP TABLE v2_products_with_variants ON COMMIT DROP AS
SELECT p.id
FROM "Product" p
WHERE EXISTS (
    SELECT 1 FROM "Variant" v
    WHERE v."productId" = p.id AND v.id NOT IN (p.id || '_default', p.id || '_legacy')
  )
  AND NOT EXISTS (SELECT 1 FROM "Variant" d WHERE d.id = p.id || '_default');

-- Product-level stock and price of products that have variants: kept on the variants, reported here.
INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_dropped_' || p.id, 'VariantMigration', p.id, 'PRODUCT_STOCK_PRICE_DROPPED',
       jsonb_build_object(
         'productQuantity', p."quantity",
         'productPrice', p."price"::text,
         'productBasePrice', p."basePrice"::text,
         'variantCount', (SELECT count(*) FROM "Variant" v WHERE v."productId" = p.id),
         'variantQuantity', (SELECT COALESCE(sum(v."quantity"), 0) FROM "Variant" v WHERE v."productId" = p.id)
       )
FROM "Product" p JOIN v2_products_with_variants w ON w.id = p.id
ON CONFLICT ("id") DO NOTHING;

-- size/color -> Apparel option values. Values that would not pass attribute-validation.ts (over 200 characters, or
-- containing "|") are not mapped: the variant is archived and reported.
CREATE TEMP TABLE v2_sized_variants ON COMMIT DROP AS
SELECT v.id, v."productId",
       NULLIF(btrim(v."size"), '') AS size,
       NULLIF(btrim(v."color"), '') AS colour
FROM "Variant" v
WHERE v."optionValues" = '{}'::jsonb
  AND (NULLIF(btrim(v."size"), '') IS NOT NULL OR NULLIF(btrim(v."color"), '') IS NOT NULL);

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_options_not_mapped_' || s.id, 'VariantMigration', s."productId", 'OPTIONS_NOT_MAPPED',
       jsonb_build_object(
         'variantId', s.id,
         'reason', CASE WHEN p."productTypeId" <> 'product_type_general'
                        THEN 'product has type ' || p."productTypeId" || ', not General'
                        ELSE 'size or colour longer than 200 characters or containing "|"' END
       )
FROM v2_sized_variants s JOIN "Product" p ON p.id = s."productId"
WHERE p."productTypeId" NOT IN ('product_type_general', 'product_type_apparel')
   OR length(COALESCE(s.size, '')) > 200 OR length(COALESCE(s.colour, '')) > 200
   OR COALESCE(s.size, '') LIKE '%|%' OR COALESCE(s.colour, '') LIKE '%|%'
ON CONFLICT ("id") DO NOTHING;

UPDATE "Variant" v SET "isActive" = false
FROM "AuditLog" a
WHERE a."id" = 'variant_migration_options_not_mapped_' || v.id AND v."isActive";

DELETE FROM v2_sized_variants s
USING "AuditLog" a
WHERE a."id" = 'variant_migration_options_not_mapped_' || s.id;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT DISTINCT 'variant_migration_apparel_' || p.id, 'VariantMigration', p.id, 'SWITCHED_TO_APPAREL',
       jsonb_build_object('from', p."productTypeId")
FROM "Product" p JOIN v2_sized_variants s ON s."productId" = p.id
WHERE p."productTypeId" = 'product_type_general'
ON CONFLICT ("id") DO NOTHING;

UPDATE "Product" p SET "productTypeId" = 'product_type_apparel'
WHERE p."productTypeId" = 'product_type_general'
  AND EXISTS (SELECT 1 FROM v2_sized_variants s WHERE s."productId" = p.id);

-- The canonical key matches attribute-validation.ts optionsKey: keys sorted, values lower-cased, "|"-joined.
UPDATE "Variant" v
SET "optionValues" = jsonb_strip_nulls(jsonb_build_object('size', s.size, 'colour', s.colour)),
    "optionsKey" = concat_ws('|', 'colour=' || lower(s.colour), 'size=' || lower(s.size))
FROM v2_sized_variants s
WHERE v.id = s.id;

-- Duplicate combinations among active variants: the oldest stays active.
CREATE TEMP TABLE v2_duplicates ON COMMIT DROP AS
SELECT v.id, v."productId", v."optionsKey",
       first_value(v.id) OVER (PARTITION BY v."productId", v."optionsKey" ORDER BY v."createdAt", v.id) AS kept
FROM "Variant" v
WHERE v."isActive"
  AND EXISTS (
    SELECT 1 FROM "Variant" o
    WHERE o."productId" = v."productId" AND o."optionsKey" = v."optionsKey" AND o."isActive" AND o.id <> v.id
  );

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_duplicate_' || d.id, 'VariantMigration', d."productId", 'DUPLICATE_OPTIONS_ARCHIVED',
       jsonb_build_object('variantId', d.id, 'keptVariantId', d.kept, 'optionsKey', d."optionsKey")
FROM v2_duplicates d
WHERE d.id <> d.kept
ON CONFLICT ("id") DO NOTHING;

UPDATE "Variant" v SET "isActive" = false
FROM v2_duplicates d
WHERE d.id = v.id AND d.id <> d.kept;

-- basePrice of existing variants: equal to price when the product is not taxable; never reverse-computed from a
-- tax-inclusive price (migration rule 3), so taxable ones are reported (after the default variants exist).
UPDATE "Variant" v SET "basePrice" = v."price"
FROM "Product" p
WHERE p.id = v."productId" AND NOT p."isTaxable" AND v."basePrice" IS NULL AND v."price" IS NOT NULL;

UPDATE "Variant" SET "sku" = 'SKU-' || upper("id") WHERE "sku" IS NULL;

-- Default variants. One for a product without a price is archived (it cannot be sold) and reported.
INSERT INTO "Variant" ("id", "productId", "sku", "barcode", "optionValues", "optionsKey", "quantity", "price",
                       "basePrice", "isActive", "lowStockThreshold", "createdAt", "updatedAt")
SELECT p.id || '_default', p.id, COALESCE(p."sku", 'SKU-' || upper(p.id)), p."barcode", '{}', '', p."quantity",
       p."price", p."basePrice", p."price" IS NOT NULL, COALESCE(p."lowStockAlert", 5), CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM "Product" p
WHERE NOT EXISTS (SELECT 1 FROM "Variant" v WHERE v."productId" = p.id)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_no_price_' || v.id, 'VariantMigration', v."productId", 'DEFAULT_VARIANT_WITHOUT_PRICE',
       jsonb_build_object('variantId', v.id)
FROM "Variant" v
WHERE v.id = v."productId" || '_default' AND v."price" IS NULL
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_base_price_' || v.id, 'VariantMigration', v."productId", 'MISSING_BASE_PRICE',
       jsonb_build_object('variantId', v.id, 'price', v."price"::text)
FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
WHERE p."isTaxable" AND v."basePrice" IS NULL
ON CONFLICT ("id") DO NOTHING;

-- Legacy variants anchor history recorded against a product that has variants.
CREATE TEMP TABLE v2_unanchored ON COMMIT DROP AS
SELECT w.id AS "productId",
       (SELECT count(*) FROM "CartItem" c WHERE c."productId" = w.id AND c."variantId" IS NULL) AS cart_items,
       (SELECT count(*) FROM "OrderItem" o WHERE o."productId" = w.id AND o."variantId" IS NULL) AS order_items,
       (SELECT count(*) FROM "InventoryLog" l WHERE l."productId" = w.id AND l."variantId" IS NULL) AS inventory_logs
FROM v2_products_with_variants w;

DELETE FROM v2_unanchored WHERE cart_items + order_items + inventory_logs = 0;

INSERT INTO "Variant" ("id", "productId", "sku", "optionValues", "optionsKey", "quantity", "price", "basePrice",
                       "isActive", "createdAt", "updatedAt")
SELECT p.id || '_legacy', p.id, 'LEGACY-' || upper(p.id), '{}', '', 0, p."price", p."basePrice", false,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Product" p JOIN v2_unanchored u ON u."productId" = p.id
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "details")
SELECT 'variant_migration_legacy_' || u."productId", 'VariantMigration', u."productId", 'LEGACY_VARIANT_CREATED',
       jsonb_build_object('variantId', u."productId" || '_legacy', 'cartItems', u.cart_items,
                          'orderItems', u.order_items, 'inventoryLogs', u.inventory_logs)
FROM v2_unanchored u
ON CONFLICT ("id") DO NOTHING;

UPDATE "CartItem" c SET "variantId" = c."productId" || '_legacy'
FROM v2_unanchored u WHERE u."productId" = c."productId" AND c."variantId" IS NULL;
UPDATE "OrderItem" o SET "variantId" = o."productId" || '_legacy'
FROM v2_unanchored u WHERE u."productId" = o."productId" AND o."variantId" IS NULL;
UPDATE "InventoryLog" l SET "variantId" = l."productId" || '_legacy'
FROM v2_unanchored u WHERE u."productId" = l."productId" AND l."variantId" IS NULL;

-- The history of every other product belongs to its default variant.
UPDATE "CartItem" c SET "variantId" = c."productId" || '_default'
WHERE c."variantId" IS NULL AND EXISTS (SELECT 1 FROM "Variant" v WHERE v.id = c."productId" || '_default');
UPDATE "OrderItem" o SET "variantId" = o."productId" || '_default'
WHERE o."variantId" IS NULL AND EXISTS (SELECT 1 FROM "Variant" v WHERE v.id = o."productId" || '_default');
UPDATE "InventoryLog" l SET "variantId" = l."productId" || '_default'
WHERE l."variantId" IS NULL AND EXISTS (SELECT 1 FROM "Variant" v WHERE v.id = l."productId" || '_default');

ALTER TABLE "Variant" ALTER COLUMN "sku" SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Variant_productId_optionsKey_key" ON "Variant"("productId", "optionsKey") WHERE ("isActive");

DO $$
DECLARE
  summary text;
BEGIN
  SELECT COALESCE(string_agg(action || ': ' || n, ', ' ORDER BY action), 'nothing to report')
  INTO summary
  FROM (SELECT action, count(*) AS n FROM "AuditLog" WHERE entity = 'VariantMigration' GROUP BY action) counts;
  RAISE NOTICE 'Variant migration report (scripts/reports/variant-migration-report.sql): %', summary;
END $$;
