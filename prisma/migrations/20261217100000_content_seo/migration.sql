-- P8-C content and SEO, expand + backfill. Products, categories, sub-categories and brands get a slug (unique per kind,
-- made from the name by a trigger when not given) and SEO meta fields; a slug change leaves a SlugRedirect (trigger).
-- New: collections (manual or rule-based), banners, homepage sections and path redirects, and the content.view /
-- content.manage permissions. 20261217100100_content_seo_contract makes the slugs unique and well-formed once the
-- backfill has filled them; it ships in the same release.

-- CreateEnum
CREATE TYPE "SlugEntityType" AS ENUM ('PRODUCT', 'CATEGORY', 'SUB_CATEGORY', 'BRAND', 'COLLECTION');

-- CreateEnum
CREATE TYPE "CollectionType" AS ENUM ('MANUAL', 'RULE');

-- CreateEnum
CREATE TYPE "HomepageSectionType" AS ENUM ('PRODUCT_CAROUSEL', 'CATEGORY_GRID', 'BANNER_STRIP', 'RICH_TEXT', 'BRAND_STRIP');

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "metaDescription" VARCHAR(320),
ADD COLUMN     "metaTitle" VARCHAR(120),
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "slug" VARCHAR(100) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "metaDescription" VARCHAR(320),
ADD COLUMN     "metaTitle" VARCHAR(120),
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "slug" VARCHAR(100) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "metaDescription" VARCHAR(320),
ADD COLUMN     "metaTitle" VARCHAR(120),
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "slug" VARCHAR(100) NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "SubCategory" ADD COLUMN     "metaDescription" VARCHAR(320),
ADD COLUMN     "metaTitle" VARCHAR(120),
ADD COLUMN     "ogImageUrl" TEXT,
ADD COLUMN     "slug" VARCHAR(100) NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "SlugRedirect" (
    "id" TEXT NOT NULL,
    "entityType" "SlugEntityType" NOT NULL,
    "fromSlug" VARCHAR(100) NOT NULL,
    "productId" TEXT,
    "categoryId" TEXT,
    "subCategoryId" TEXT,
    "brandId" TEXT,
    "collectionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlugRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Collection" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "slug" VARCHAR(100) NOT NULL DEFAULT '',
    "description" TEXT,
    "imageUrl" TEXT,
    "type" "CollectionType" NOT NULL,
    "rules" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "metaTitle" VARCHAR(120),
    "metaDescription" VARCHAR(320),
    "ogImageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionProduct" (
    "collectionId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "CollectionProduct_pkey" PRIMARY KEY ("collectionId","productId")
);

-- CreateTable
CREATE TABLE "Banner" (
    "id" TEXT NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "subtitle" VARCHAR(240),
    "altText" VARCHAR(240),
    "imageUrl" TEXT NOT NULL,
    "mobileImageUrl" TEXT,
    "placement" VARCHAR(50) NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "linkProductId" TEXT,
    "linkCategoryId" TEXT,
    "linkCollectionId" TEXT,
    "linkPath" VARCHAR(500),
    "linkUrl" VARCHAR(2000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Banner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomepageSection" (
    "id" TEXT NOT NULL,
    "type" "HomepageSectionType" NOT NULL,
    "title" VARCHAR(120),
    "position" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomepageSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PathRedirect" (
    "id" TEXT NOT NULL,
    "fromPath" VARCHAR(500) NOT NULL,
    "toPath" VARCHAR(500) NOT NULL,
    "statusCode" INTEGER NOT NULL DEFAULT 301,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PathRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlugRedirect_productId_idx" ON "SlugRedirect"("productId");

-- CreateIndex
CREATE INDEX "SlugRedirect_categoryId_idx" ON "SlugRedirect"("categoryId");

-- CreateIndex
CREATE INDEX "SlugRedirect_subCategoryId_idx" ON "SlugRedirect"("subCategoryId");

-- CreateIndex
CREATE INDEX "SlugRedirect_brandId_idx" ON "SlugRedirect"("brandId");

-- CreateIndex
CREATE INDEX "SlugRedirect_collectionId_idx" ON "SlugRedirect"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SlugRedirect_entityType_fromSlug_key" ON "SlugRedirect"("entityType", "fromSlug");

-- CreateIndex
CREATE UNIQUE INDEX "Collection_slug_key" ON "Collection"("slug");

-- CreateIndex
CREATE INDEX "CollectionProduct_productId_idx" ON "CollectionProduct"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionProduct_collectionId_position_key" ON "CollectionProduct"("collectionId", "position");

-- CreateIndex
CREATE INDEX "Banner_placement_position_idx" ON "Banner"("placement", "position");

-- CreateIndex
CREATE INDEX "Banner_linkProductId_idx" ON "Banner"("linkProductId");

-- CreateIndex
CREATE INDEX "Banner_linkCategoryId_idx" ON "Banner"("linkCategoryId");

-- CreateIndex
CREATE INDEX "Banner_linkCollectionId_idx" ON "Banner"("linkCollectionId");

-- CreateIndex
CREATE INDEX "HomepageSection_position_idx" ON "HomepageSection"("position");

-- CreateIndex
CREATE UNIQUE INDEX "PathRedirect_fromPath_key" ON "PathRedirect"("fromPath");

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_subCategoryId_fkey" FOREIGN KEY ("subCategoryId") REFERENCES "SubCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_linkProductId_fkey" FOREIGN KEY ("linkProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_linkCategoryId_fkey" FOREIGN KEY ("linkCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_linkCollectionId_fkey" FOREIGN KEY ("linkCollectionId") REFERENCES "Collection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Content rules the schema cannot express
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_entity_check" CHECK (
  num_nonnulls("productId", "categoryId", "subCategoryId", "brandId", "collectionId") = 1
  AND CASE "entityType"
    WHEN 'PRODUCT' THEN "productId" IS NOT NULL
    WHEN 'CATEGORY' THEN "categoryId" IS NOT NULL
    WHEN 'SUB_CATEGORY' THEN "subCategoryId" IS NOT NULL
    WHEN 'BRAND' THEN "brandId" IS NOT NULL
    WHEN 'COLLECTION' THEN "collectionId" IS NOT NULL
  END
);
ALTER TABLE "SlugRedirect" ADD CONSTRAINT "SlugRedirect_fromSlug_check" CHECK ("fromSlug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_rules_check" CHECK (("type" = 'RULE') = ("rules" IS NOT NULL));
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_schedule_check"
  CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");
ALTER TABLE "CollectionProduct" ADD CONSTRAINT "CollectionProduct_position_check" CHECK ("position" >= 0);

ALTER TABLE "Banner" ADD CONSTRAINT "Banner_link_check"
  CHECK (num_nonnulls("linkProductId", "linkCategoryId", "linkCollectionId", "linkPath", "linkUrl") <= 1);
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_placement_check" CHECK ("placement" ~ '^[A-Z][A-Z0-9_]*$');
ALTER TABLE "Banner" ADD CONSTRAINT "Banner_schedule_check"
  CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "HomepageSection" ADD CONSTRAINT "HomepageSection_schedule_check"
  CHECK ("startsAt" IS NULL OR "endsAt" IS NULL OR "endsAt" > "startsAt");

ALTER TABLE "PathRedirect" ADD CONSTRAINT "PathRedirect_statusCode_check" CHECK ("statusCode" IN (301, 302));
ALTER TABLE "PathRedirect" ADD CONSTRAINT "PathRedirect_paths_check" CHECK ("fromPath" <> "toPath");

-- The slug of a name: accents dropped (NFKD), a few letters spelled out, "&" read as "and", apostrophes dropped, every
-- other run of non-alphanumerics a hyphen, lower case, at most 80 characters; the fallback when nothing is left (e.g. a
-- name in a non-Latin script). The backfill and every insert without a slug use it.
CREATE FUNCTION "seo_slug_base"(name TEXT, fallback TEXT) RETURNS TEXT LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT coalesce(nullif(btrim(left(btrim(regexp_replace(
    replace(replace(replace(replace(translate(
      regexp_replace(lower(regexp_replace(normalize(replace(name, '&', ' and '), NFKD), '[̀-ͯ]', '', 'g')),
                     '[''’]', '', 'g'),
      'øđłðı', 'odldi'), 'ß', 'ss'), 'æ', 'ae'), 'œ', 'oe'), 'þ', 'th'),
    '[^a-z0-9]+', '-', 'g'), '-'), 80), '-'), ''), fallback)
$$;

-- The first of base, base-2, base-3, ... that no other row of the table has as its slug and that is not an old slug
-- (SlugRedirect) of that kind, so old links keep reaching their page.
CREATE FUNCTION "seo_unique_slug"(entity "SlugEntityType", tbl REGCLASS, base TEXT, self_id TEXT)
RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  candidate TEXT := base;
  n INT := 1;
  taken BOOLEAN;
BEGIN
  -- One pick at a time per kind until commit, so two inserts of the same name never pick the same slug.
  PERFORM pg_advisory_xact_lock(hashtext('seo_unique_slug'), hashtext(entity::TEXT));
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE "slug" = $1 AND "id" <> $2)', tbl)
      INTO taken USING candidate, self_id;
    taken := taken OR EXISTS (
      SELECT 1 FROM "SlugRedirect" r WHERE r."entityType" = entity AND r."fromSlug" = candidate
    );
    EXIT WHEN NOT taken;
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  RETURN candidate;
END
$$;

-- Arguments: entity type, fallback word. Without a slug, one is made from the name; a slug given explicitly takes
-- precedence over another entity's old slug, whose redirect goes.
CREATE FUNCTION "seo_slug_before_insert"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  entity "SlugEntityType" := TG_ARGV[0]::"SlugEntityType";
BEGIN
  IF NEW."slug" IS NULL OR NEW."slug" = '' THEN
    NEW."slug" := "seo_unique_slug"(entity, TG_RELID::REGCLASS, "seo_slug_base"(NEW."name", TG_ARGV[1]), NEW."id");
  ELSE
    DELETE FROM "SlugRedirect" WHERE "entityType" = entity AND "fromSlug" = NEW."slug";
  END IF;
  RETURN NEW;
END
$$;

-- Arguments: entity type, SlugRedirect column. The old slug becomes a redirect to the row; a redirect of the new slug
-- (the row's own, or another entity's) goes, since the slug is live again.
CREATE FUNCTION "seo_slug_after_update"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  entity "SlugEntityType" := TG_ARGV[0]::"SlugEntityType";
BEGIN
  DELETE FROM "SlugRedirect" WHERE "entityType" = entity AND "fromSlug" = NEW."slug";
  EXECUTE format('INSERT INTO "SlugRedirect" ("id", "entityType", "fromSlug", %I) VALUES ($1, $2, $3, $4)', TG_ARGV[1])
    USING gen_random_uuid()::TEXT, entity, OLD."slug", NEW."id";
  RETURN NULL;
END
$$;

CREATE TRIGGER "Product_slug_insert" BEFORE INSERT ON "Product"
  FOR EACH ROW EXECUTE FUNCTION "seo_slug_before_insert"('PRODUCT', 'product');
CREATE TRIGGER "Category_slug_insert" BEFORE INSERT ON "Category"
  FOR EACH ROW EXECUTE FUNCTION "seo_slug_before_insert"('CATEGORY', 'category');
CREATE TRIGGER "SubCategory_slug_insert" BEFORE INSERT ON "SubCategory"
  FOR EACH ROW EXECUTE FUNCTION "seo_slug_before_insert"('SUB_CATEGORY', 'subcategory');
CREATE TRIGGER "Brand_slug_insert" BEFORE INSERT ON "Brand"
  FOR EACH ROW EXECUTE FUNCTION "seo_slug_before_insert"('BRAND', 'brand');
CREATE TRIGGER "Collection_slug_insert" BEFORE INSERT ON "Collection"
  FOR EACH ROW EXECUTE FUNCTION "seo_slug_before_insert"('COLLECTION', 'collection');

-- The backfill fills empty slugs, which leaves no redirect.
CREATE TRIGGER "Product_slug_redirect" AFTER UPDATE OF "slug" ON "Product"
  FOR EACH ROW WHEN (OLD."slug" IS DISTINCT FROM NEW."slug" AND OLD."slug" <> '')
  EXECUTE FUNCTION "seo_slug_after_update"('PRODUCT', 'productId');
CREATE TRIGGER "Category_slug_redirect" AFTER UPDATE OF "slug" ON "Category"
  FOR EACH ROW WHEN (OLD."slug" IS DISTINCT FROM NEW."slug" AND OLD."slug" <> '')
  EXECUTE FUNCTION "seo_slug_after_update"('CATEGORY', 'categoryId');
CREATE TRIGGER "SubCategory_slug_redirect" AFTER UPDATE OF "slug" ON "SubCategory"
  FOR EACH ROW WHEN (OLD."slug" IS DISTINCT FROM NEW."slug" AND OLD."slug" <> '')
  EXECUTE FUNCTION "seo_slug_after_update"('SUB_CATEGORY', 'subCategoryId');
CREATE TRIGGER "Brand_slug_redirect" AFTER UPDATE OF "slug" ON "Brand"
  FOR EACH ROW WHEN (OLD."slug" IS DISTINCT FROM NEW."slug" AND OLD."slug" <> '')
  EXECUTE FUNCTION "seo_slug_after_update"('BRAND', 'brandId');
CREATE TRIGGER "Collection_slug_redirect" AFTER UPDATE OF "slug" ON "Collection"
  FOR EACH ROW WHEN (OLD."slug" IS DISTINCT FROM NEW."slug" AND OLD."slug" <> '')
  EXECUTE FUNCTION "seo_slug_after_update"('COLLECTION', 'collectionId');

-- content.view (Owner, Manager, Support) and content.manage (Owner, Manager)
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'content.view'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER', 'SUPPORT') AND NOT ('content.view' = ANY ("permissions"));
UPDATE "StaffRole" SET "permissions" = array_append("permissions", 'content.manage'), "updatedAt" = CURRENT_TIMESTAMP
WHERE "key" IN ('OWNER', 'MANAGER') AND NOT ('content.manage' = ANY ("permissions"));

-- Backfill, safe to re-run: each row still without a slug gets one from its name, oldest first (ties by id), so the
-- result is deterministic; a clash takes the next free "-2", "-3", ... The partial unique indexes keep the filled slugs
-- unique and make the lookups cheap until 20261217100100_content_seo_contract replaces them with plain ones.
CREATE UNIQUE INDEX IF NOT EXISTS "Product_slug_backfill_key" ON "Product"("slug") WHERE "slug" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "Category_slug_backfill_key" ON "Category"("slug") WHERE "slug" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "SubCategory_slug_backfill_key" ON "SubCategory"("slug") WHERE "slug" <> '';
CREATE UNIQUE INDEX IF NOT EXISTS "Brand_slug_backfill_key" ON "Brand"("slug") WHERE "slug" <> '';

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT "id", "name" FROM "Category" WHERE "slug" = '' ORDER BY "createdAt", "id" LOOP
    UPDATE "Category" SET "slug" = "seo_unique_slug"('CATEGORY'::"SlugEntityType", '"Category"'::REGCLASS, "seo_slug_base"(r."name", 'category'), r."id")
    WHERE "id" = r."id";
  END LOOP;
  FOR r IN SELECT "id", "name" FROM "SubCategory" WHERE "slug" = '' ORDER BY "createdAt", "id" LOOP
    UPDATE "SubCategory" SET "slug" = "seo_unique_slug"('SUB_CATEGORY'::"SlugEntityType", '"SubCategory"'::REGCLASS, "seo_slug_base"(r."name", 'subcategory'), r."id")
    WHERE "id" = r."id";
  END LOOP;
  FOR r IN SELECT "id", "name" FROM "Brand" WHERE "slug" = '' ORDER BY "createdAt", "id" LOOP
    UPDATE "Brand" SET "slug" = "seo_unique_slug"('BRAND'::"SlugEntityType", '"Brand"'::REGCLASS, "seo_slug_base"(r."name", 'brand'), r."id")
    WHERE "id" = r."id";
  END LOOP;
  FOR r IN SELECT "id", "name" FROM "Product" WHERE "slug" = '' ORDER BY "createdAt", "id" LOOP
    UPDATE "Product" SET "slug" = "seo_unique_slug"('PRODUCT'::"SlugEntityType", '"Product"'::REGCLASS, "seo_slug_base"(r."name", 'product'), r."id")
    WHERE "id" = r."id";
  END LOOP;
  RAISE NOTICE 'Slug backfill: categories %, sub-categories %, brands %, products % (all with a slug now)',
    (SELECT count(*) FROM "Category"), (SELECT count(*) FROM "SubCategory"),
    (SELECT count(*) FROM "Brand"), (SELECT count(*) FROM "Product");
END
$$;
