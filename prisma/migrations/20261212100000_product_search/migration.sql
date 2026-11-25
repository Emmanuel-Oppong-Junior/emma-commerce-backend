-- P6-S.1 product search (ADR-0010, Postgres adapter): a weighted full-text document per product with a GIN index,
-- and trigram indexes for typo-tolerant name matching and autocomplete.

-- Trusted extension since PostgreSQL 13: the database owner can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "searchVector" tsvector;

-- The 'simple' configuration lower-cases words without stemming or stop words: Twi, Ga, Ewe and Hausa product words
-- (kenkey, shito, kente) and brand names stay whole instead of being cut by English rules.
CREATE FUNCTION "product_search_vector"(name TEXT, short_description TEXT, description TEXT, related TEXT)
RETURNS tsvector LANGUAGE sql IMMUTABLE AS $$
  SELECT setweight(to_tsvector('simple', coalesce(name, '')), 'A')
      || setweight(to_tsvector('simple', coalesce(related, '')), 'B')
      || setweight(to_tsvector('simple', concat_ws(' ', short_description, description)), 'C')
$$;

-- Brand, category, sub-category and tag names of a product. A generated column cannot read other tables, so the
-- document is kept by triggers instead.
CREATE FUNCTION "product_search_related"(product_id TEXT, brand_id TEXT, category_id TEXT, subcategory_id TEXT)
RETURNS TEXT LANGUAGE sql STABLE AS $$
  SELECT concat_ws(' ',
    (SELECT b."name" FROM "Brand" b WHERE b."id" = brand_id),
    (SELECT c."name" FROM "Category" c WHERE c."id" = category_id),
    (SELECT s."name" FROM "SubCategory" s WHERE s."id" = subcategory_id),
    (SELECT string_agg(t."name", ' ' ORDER BY t."name") FROM "_ProductToTag" pt JOIN "Tag" t ON t."id" = pt."B"
     WHERE pt."A" = product_id))
$$;

CREATE FUNCTION "product_search_vector_set"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."searchVector" := "product_search_vector"(NEW."name", NEW."shortDescription", NEW."description",
    "product_search_related"(NEW."id", NEW."brandId", NEW."categoryId", NEW."subcategoryId"));
  RETURN NEW;
END $$;
CREATE TRIGGER "Product_search_vector" BEFORE INSERT OR UPDATE OF "name", "shortDescription", "description", "brandId",
  "categoryId", "subcategoryId" ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_set"();

-- Rebuilds the documents of the given products. Setting only "searchVector" does not fire the trigger above.
CREATE FUNCTION "product_search_vector_rebuild"(product_ids TEXT[]) RETURNS void LANGUAGE sql AS $$
  UPDATE "Product" p SET "searchVector" = "product_search_vector"(p."name", p."shortDescription", p."description",
    "product_search_related"(p."id", p."brandId", p."categoryId", p."subcategoryId"))
  WHERE p."id" = ANY (product_ids)
$$;

-- A renamed brand, category, sub-category or tag, or a tag added to or removed from a product, changes the documents
-- of the products it touches.
CREATE FUNCTION "product_search_vector_refresh"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = '_ProductToTag' THEN
    IF TG_OP = 'DELETE' THEN
      PERFORM "product_search_vector_rebuild"(ARRAY[OLD."A"]);
    ELSE
      PERFORM "product_search_vector_rebuild"(ARRAY[NEW."A"]);
    END IF;
  ELSIF NEW."name" IS DISTINCT FROM OLD."name" THEN
    IF TG_TABLE_NAME = 'Brand' THEN
      PERFORM "product_search_vector_rebuild"(ARRAY(SELECT "id" FROM "Product" WHERE "brandId" = NEW."id"));
    ELSIF TG_TABLE_NAME = 'Category' THEN
      PERFORM "product_search_vector_rebuild"(ARRAY(SELECT "id" FROM "Product" WHERE "categoryId" = NEW."id"));
    ELSIF TG_TABLE_NAME = 'SubCategory' THEN
      PERFORM "product_search_vector_rebuild"(ARRAY(SELECT "id" FROM "Product" WHERE "subcategoryId" = NEW."id"));
    ELSE
      PERFORM "product_search_vector_rebuild"(ARRAY(SELECT "A" FROM "_ProductToTag" WHERE "B" = NEW."id"));
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER "Brand_search_vector" AFTER UPDATE OF "name" ON "Brand"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_refresh"();
CREATE TRIGGER "Category_search_vector" AFTER UPDATE OF "name" ON "Category"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_refresh"();
CREATE TRIGGER "SubCategory_search_vector" AFTER UPDATE OF "name" ON "SubCategory"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_refresh"();
CREATE TRIGGER "Tag_search_vector" AFTER UPDATE OF "name" ON "Tag"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_refresh"();
CREATE TRIGGER "ProductToTag_search_vector" AFTER INSERT OR DELETE ON "_ProductToTag"
  FOR EACH ROW EXECUTE FUNCTION "product_search_vector_refresh"();

-- Backfill (safe to re-run).
SELECT "product_search_vector_rebuild"(ARRAY(SELECT "id" FROM "Product"));

-- CreateIndex
CREATE INDEX "Product_searchVector_idx" ON "Product" USING GIN ("searchVector");

-- CreateIndex
CREATE INDEX "Product_name_trgm_idx" ON "Product" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Brand_name_trgm_idx" ON "Brand" USING GIN ("name" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "Category_name_trgm_idx" ON "Category" USING GIN ("name" gin_trgm_ops);
