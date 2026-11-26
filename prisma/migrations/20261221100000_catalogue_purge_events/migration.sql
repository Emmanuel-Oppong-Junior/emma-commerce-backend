-- P9-C: every committed catalogue change records a catalogue.changed.v1 outbox event, so the worker can purge the
-- CDN by surrogate key. Triggers rather than service code: they sit in the writing transaction on every path
-- (resolvers, bulk imports, bulk reprices, the stock ledger, cascades), so a rollback records nothing and a crash
-- loses nothing. They only say what changed ({ reason, ids }); src/cdn/surrogate-keys.ts turns that into keys.
-- One event per statement (transition tables), so a bulk write is one event; ids are capped at 100 (null = many).

CREATE FUNCTION "catalogue_changed_record"(reason TEXT, ids TEXT[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "OutboxEvent" ("id", "type", "aggregateId", "payload")
  VALUES (
    'catalogue_changed_' || gen_random_uuid(),
    'catalogue.changed.v1',
    reason,
    jsonb_build_object('reason', reason, 'ids', CASE WHEN cardinality(ids) <= 100 THEN to_jsonb(ids) END)
  );
END $$;

-- Statement-level: TG_ARGV[0] is the reason, TG_ARGV[1] (optional) the column holding the id the reason is about.
-- Without an id column, any changed row records one event with ids null.
CREATE FUNCTION "catalogue_rows_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  id_column TEXT := TG_ARGV[1];
  ids TEXT[];
  changed BOOLEAN;
BEGIN
  IF id_column IS NULL THEN
    EXECUTE CASE TG_OP WHEN 'DELETE' THEN 'SELECT EXISTS (SELECT 1 FROM old_rows)'
                       ELSE 'SELECT EXISTS (SELECT 1 FROM new_rows)' END INTO changed;
    IF changed THEN
      PERFORM "catalogue_changed_record"(TG_ARGV[0], NULL);
    END IF;
    RETURN NULL;
  END IF;

  EXECUTE format(CASE TG_OP
      WHEN 'INSERT' THEN 'SELECT array_agg(DISTINCT %1$I) FROM new_rows WHERE %1$I IS NOT NULL'
      WHEN 'DELETE' THEN 'SELECT array_agg(DISTINCT %1$I) FROM old_rows WHERE %1$I IS NOT NULL'
      ELSE 'SELECT array_agg(DISTINCT id) FROM (SELECT %1$I AS id FROM old_rows UNION SELECT %1$I FROM new_rows) changed
            WHERE id IS NOT NULL'
    END, id_column) INTO ids;
  IF cardinality(ids) > 0 THEN
    PERFORM "catalogue_changed_record"(TG_ARGV[0], ids);
  END IF;
  RETURN NULL;
END $$;

DO $$
DECLARE
  t RECORD;
  args TEXT;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('Product', 'product', 'id'),
    ('Variant', 'product', 'productId'),
    ('_ProductToTag', 'product', 'A'),
    ('Category', 'category', 'id'),
    ('SubCategory', 'subcategory', 'id'),
    ('Brand', 'brand', 'id'),
    ('Tag', 'tag', 'id'),
    ('ProductType', 'product-type', 'id'),
    ('AttributeDefinition', 'product-type', 'productTypeId'),
    ('Collection', 'collection', 'id'),
    ('CollectionProduct', 'collection', 'collectionId'),
    ('Banner', 'banner', 'id'),
    ('HomepageSection', 'homepage', NULL),
    ('PathRedirect', 'redirect', NULL),
    ('SlugRedirect', 'redirect', NULL),
    ('StoreFeature', 'store-feature', NULL),
    ('StockLocation', 'stock-location', NULL),
    ('ShippingZoneStockLocation', 'stock-location', NULL),
    ('PickupLocationStockLocation', 'stock-location', NULL),
    ('PromotionTier', 'promotion', NULL),
    ('_ProductToPromotion', 'promotion', NULL),
    ('_PromotionToVariant', 'promotion', NULL),
    ('_CategoryToPromotion', 'promotion', NULL),
    ('_BrandToPromotion', 'promotion', NULL),
    ('_PromotionRewardProducts', 'promotion', NULL),
    ('_PromotionRewardVariants', 'promotion', NULL),
    ('_PromotionRewardCategories', 'promotion', NULL),
    ('_PromotionRewardBrands', 'promotion', NULL),
    ('_CustomerGroupToPromotion', 'promotion', NULL)
  ) AS v(tbl, reason, id_column)
  LOOP
    args := quote_literal(t.reason) || COALESCE(', ' || quote_literal(t.id_column), '');
    EXECUTE format('CREATE TRIGGER %I AFTER INSERT ON %I REFERENCING NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_rows_changed"(%s)', t.tbl || '_catalogue_insert', t.tbl, args);
    EXECUTE format('CREATE TRIGGER %I AFTER UPDATE ON %I REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
      FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_rows_changed"(%s)', t.tbl || '_catalogue_update', t.tbl, args);
    EXECUTE format('CREATE TRIGGER %I AFTER DELETE ON %I REFERENCING OLD TABLE AS old_rows
      FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_rows_changed"(%s)', t.tbl || '_catalogue_delete', t.tbl, args);
  END LOOP;
END $$;

-- Promotions: created or deleted always; updated only when the display could change. Every paid order bumps
-- usedCount/unitsUsed, which matters only when it reaches usageLimit/unitCap (the promotion stops applying).
CREATE FUNCTION "catalogue_promotion_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "catalogue_changed_record"('promotion', NULL);
  RETURN NULL;
END $$;

CREATE TRIGGER "Promotion_catalogue_insert" AFTER INSERT ON "Promotion" REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_rows_changed"('promotion');
CREATE TRIGGER "Promotion_catalogue_delete" AFTER DELETE ON "Promotion" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_rows_changed"('promotion');
CREATE TRIGGER "Promotion_catalogue_update" AFTER UPDATE ON "Promotion" FOR EACH ROW
  WHEN (
    (to_jsonb(OLD) - 'usedCount' - 'unitsUsed' - 'updatedAt') IS DISTINCT FROM
      (to_jsonb(NEW) - 'usedCount' - 'unitsUsed' - 'updatedAt')
    OR (OLD."usedCount" >= OLD."usageLimit") IS DISTINCT FROM (NEW."usedCount" >= NEW."usageLimit")
    OR (OLD."unitsUsed" >= OLD."unitCap") IS DISTINCT FROM (NEW."unitsUsed" >= NEW."unitCap")
  )
  EXECUTE FUNCTION "catalogue_promotion_changed"();

-- The store row: every order takes the next order number, which no cached page shows.
CREATE FUNCTION "catalogue_store_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "catalogue_changed_record"('store', NULL);
  RETURN NULL;
END $$;

CREATE TRIGGER "Store_catalogue_update" AFTER UPDATE ON "Store" FOR EACH ROW
  WHEN ((to_jsonb(OLD) - 'nextOrderNumber' - 'updatedAt') IS DISTINCT FROM (to_jsonb(NEW) - 'nextOrderNumber' - 'updatedAt'))
  EXECUTE FUNCTION "catalogue_store_changed"();

-- Stock: only a level crossing between available (onHand - reserved > 0) and not, which flips inStock/available on
-- product pages; every other stock change waits for the max-age. Keyed by the variant's product.
CREATE FUNCTION "catalogue_stock_changed"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ids TEXT[];
BEGIN
  EXECUTE CASE TG_OP
    WHEN 'INSERT' THEN
      'SELECT array_agg(DISTINCT v."productId") FROM new_rows n JOIN "Variant" v ON v."id" = n."variantId"
       WHERE n."onHand" - n."reserved" > 0'
    WHEN 'DELETE' THEN
      'SELECT array_agg(DISTINCT v."productId") FROM old_rows o JOIN "Variant" v ON v."id" = o."variantId"
       WHERE o."onHand" - o."reserved" > 0'
    ELSE
      'SELECT array_agg(DISTINCT v."productId") FROM old_rows o JOIN new_rows n ON n."id" = o."id"
       JOIN "Variant" v ON v."id" = n."variantId"
       WHERE (o."onHand" - o."reserved" > 0) <> (n."onHand" - n."reserved" > 0)'
  END INTO ids;
  IF cardinality(ids) > 0 THEN
    PERFORM "catalogue_changed_record"('stock', ids);
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "StockLevel_catalogue_insert" AFTER INSERT ON "StockLevel" REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_stock_changed"();
CREATE TRIGGER "StockLevel_catalogue_update" AFTER UPDATE ON "StockLevel"
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_stock_changed"();
CREATE TRIGGER "StockLevel_catalogue_delete" AFTER DELETE ON "StockLevel" REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION "catalogue_stock_changed"();
