import { Prisma } from '../../../generated/prisma/client';
import { SERVING_LOCATION_SQL } from '../../../inventory/locations/serving-locations';
import { expiredLotUnitsSql } from '../../../inventory/lots/lot-stock.repository';
import { AttributeFilter, ProductSearchFilters, ProductSortKey, SortDirection } from '../product-search.port';
import { SearchCursor, TextMatchMode } from './search-cursor';

// SQL of the Postgres search adapter, built from parameterised fragments over "Product" aliased p. Pure: no I/O.
// User text only ever reaches websearch_to_tsquery or a trigram comparison as a bound parameter, never to_tsquery.

/** Word similarity (0-1) a name needs to match a search with typos; set per transaction for the <% operator. */
export const FUZZY_WORD_SIMILARITY = 0.4;

/** The search text as a tsquery: websearch syntax, never an error, whatever the text. */
export function tsQuery(text: string): Prisma.Sql {
  return Prisma.sql`websearch_to_tsquery('simple', ${text})`;
}

const WORD = /[\p{L}\p{N}]+/gu;
const MAX_FUZZY_WORDS = 8;

/**
 * The words of the text the fuzzy match compares one by one (a typo in one word of a long name lowers a whole-text
 * similarity too much): lower case, two characters or more, at most eight. Shorter words only: the text itself.
 */
export function fuzzyWords(text: string): string[] {
  const words = [...new Set((text.toLowerCase().match(WORD) ?? []).filter((word) => word.length >= 2))];
  return words.length ? words.slice(0, MAX_FUZZY_WORDS) : [text];
}

/**
 * Whether p matches the search text (the first of `texts`; the others are its synonym variants, full-text only), and
 * its relevance (higher is better) as float8. FUZZY: every word must be similar to a part of the name (index-backed
 * <% operator); relevance is the mean similarity.
 */
export function textMatch(texts: readonly string[], mode: TextMatchMode): { condition: Prisma.Sql; score: Prisma.Sql } {
  const [text] = texts;
  if (mode === 'FTS') {
    // Synonym variants of the text: a product matches any of them.
    const query = texts.length === 1 ? tsQuery(text) : Prisma.sql`(${Prisma.join(texts.map(tsQuery), ' || ')})`;
    return {
      condition: Prisma.sql`p."searchVector" @@ ${query}`,
      score: Prisma.sql`ts_rank(p."searchVector", ${query})::float8`,
    };
  }
  const words = fuzzyWords(text);
  return {
    condition: Prisma.join(
      words.map((word) => Prisma.sql`${word} <% p."name"`),
      ' AND ',
    ),
    score: Prisma.sql`((${Prisma.join(
      words.map((word) => Prisma.sql`word_similarity(${word}, p."name")`),
      ' + ',
    )}) / ${words.length})::float8`,
  };
}

/** Variant v (aliased) can be bought now: its best serving location has unreserved, unexpired units. */
function variantSellable(now: Date): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "StockLevel" sl JOIN "StockLocation" l ON l."id" = sl."locationId"
    WHERE sl."variantId" = v."id" AND ${SERVING_LOCATION_SQL}
      AND sl."onHand" - sl."reserved" - ${expiredLotUnitsSql('sl', now)} > 0)`;
}

function priceBounds(filters: ProductSearchFilters): Prisma.Sql[] {
  const bounds: Prisma.Sql[] = [];
  if (filters.priceMin) bounds.push(Prisma.sql`v."price" >= ${filters.priceMin.toFixed(2)}::numeric`);
  if (filters.priceMax) bounds.push(Prisma.sql`v."price" <= ${filters.priceMax.toFixed(2)}::numeric`);
  return bounds;
}

function activeVariantExists(conditions: Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`EXISTS (SELECT 1 FROM "Variant" v WHERE v."productId" = p."id" AND v."isActive" AND ${Prisma.join(
    conditions,
    ' AND ',
  )})`;
}

/** Price and stock conditions: with inStock true one variant must satisfy both. */
function variantConditions(filters: ProductSearchFilters, now: Date): Prisma.Sql[] {
  const bounds = priceBounds(filters);
  if (filters.inStock === true) return [activeVariantExists([...bounds, variantSellable(now)])];
  const conditions = bounds.length ? [activeVariantExists(bounds)] : [];
  if (filters.inStock === false) conditions.push(Prisma.sql`NOT ${activeVariantExists([variantSellable(now)])}`);
  return conditions;
}

function visibilityConditions(filters: ProductSearchFilters): Prisma.Sql[] {
  if (filters.visibility === 'PUBLIC') return [Prisma.sql`p."isActive" AND p."status" = 'PUBLISHED'`];
  const conditions: Prisma.Sql[] = [];
  if (filters.isActive !== undefined) conditions.push(Prisma.sql`p."isActive" = ${filters.isActive}`);
  if (filters.status) conditions.push(Prisma.sql`p."status" = ${filters.status}::"ProductStatus"`);
  return conditions;
}

const nameIs = (table: string, idColumn: string, name: string) =>
  Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} x WHERE x."id" = p.${Prisma.raw(`"${idColumn}"`)}
    AND lower(x."name") = lower(${name}))`;

function categoryConditions(filters: ProductSearchFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.categoryId) conditions.push(Prisma.sql`p."categoryId" = ${filters.categoryId}`);
  if (filters.categoryName) conditions.push(nameIs('Category', 'categoryId', filters.categoryName));
  return conditions;
}

function brandConditions(filters: ProductSearchFilters): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filters.brandId) conditions.push(Prisma.sql`p."brandId" = ${filters.brandId}`);
  if (filters.brandName) conditions.push(nameIs('Brand', 'brandId', filters.brandName));
  return conditions;
}

/** The filters no facet counts without: visibility, sub-category, tags, product type, creation date. */
function unfacetedConditions(filters: ProductSearchFilters): Prisma.Sql[] {
  const conditions = visibilityConditions(filters);
  if (filters.subcategoryId) conditions.push(Prisma.sql`p."subcategoryId" = ${filters.subcategoryId}`);
  if (filters.subCategoryName) conditions.push(nameIs('SubCategory', 'subcategoryId', filters.subCategoryName));
  if (filters.tagId) {
    conditions.push(
      Prisma.sql`EXISTS (SELECT 1 FROM "_ProductToTag" pt WHERE pt."A" = p."id" AND pt."B" = ${filters.tagId})`,
    );
  }
  if (filters.tagName) {
    conditions.push(Prisma.sql`EXISTS (SELECT 1 FROM "_ProductToTag" pt JOIN "Tag" t ON t."id" = pt."B"
      WHERE pt."A" = p."id" AND lower(t."name") = lower(${filters.tagName}))`);
  }
  if (filters.productTypeId) conditions.push(Prisma.sql`p."productTypeId" = ${filters.productTypeId}`);
  if (filters.createdAfter) conditions.push(Prisma.sql`p."createdAt" >= ${filters.createdAfter}`);
  return conditions;
}

/** The product's own attribute, or an active variant's option value, is one of the values (ignoring case). */
function attributeCondition(filter: AttributeFilter): Prisma.Sql {
  const values = Prisma.join(filter.values.map((value) => Prisma.sql`lower(${value})`));
  return Prisma.sql`(lower(p."attributes" ->> ${filter.key}) IN (${values})
    OR EXISTS (SELECT 1 FROM "Variant" v WHERE v."productId" = p."id" AND v."isActive"
      AND lower(v."optionValues" ->> ${filter.key}) IN (${values})))`;
}

/** Every filter except the search text, each its own condition, so no filter can replace another. */
export function filterConditions(filters: ProductSearchFilters, now: Date): Prisma.Sql[] {
  return [
    ...unfacetedConditions(filters),
    ...categoryConditions(filters),
    ...brandConditions(filters),
    ...variantConditions(filters, now),
    ...(filters.attributes ?? []).map(attributeCondition),
  ];
}

export const FACET_VALUES_LIMIT = 20;
export const FACET_ATTRIBUTES_LIMIT = 10;

const and = (conditions: Prisma.Sql[]) => (conditions.length ? Prisma.join(conditions, ' AND ') : Prisma.sql`TRUE`);

/**
 * Every facet of the filters in one statement, as JSON. `base` holds the products matching the filters no facet
 * ignores (and the text match), with one flag per faceted filter; each facet then counts the rows whose flags hold
 * except its own, so the other choices of that facet stay visible.
 */
export function facetQuery(filters: ProductSearchFilters, now: Date, textCondition?: Prisma.Sql): Prisma.Sql {
  const bounds = priceBounds(filters);
  const sellable = variantSellable(now);
  const attributes = filters.attributes ?? [];
  const stockFlag =
    filters.inStock === true
      ? activeVariantExists([...bounds, sellable])
      : filters.inStock === false
        ? Prisma.sql`NOT ${activeVariantExists([sellable])}`
        : Prisma.sql`TRUE`;
  const stockAnyPriceFlag =
    filters.inStock === undefined
      ? Prisma.sql`TRUE`
      : filters.inStock
        ? activeVariantExists([sellable])
        : Prisma.sql`NOT ${activeVariantExists([sellable])}`;
  const flags = {
    brand: Prisma.sql`b."f_brand"`,
    category: Prisma.sql`b."f_category"`,
    price: Prisma.sql`b."f_price"`,
    stock: Prisma.sql`b."f_stock"`,
    attributes: attributes.map((_, i) => Prisma.raw(`b."f_a${i}"`)),
  };
  const allAttributes = flags.attributes;
  // The price facet keeps inStock (any price) but drops the bounds; its variants are the sellable ones with inStock.
  const priceVariants = filters.inStock === true ? Prisma.sql`AND ${sellable}` : Prisma.empty;
  const attributeExcept = attributes.length
    ? Prisma.join(
        attributes.map((filter, i) => Prisma.sql`(av."key" = ${filter.key} OR ${flags.attributes[i]})`),
        ' AND ',
      )
    : Prisma.sql`TRUE`;
  const limitValues = FACET_VALUES_LIMIT;

  return Prisma.sql`
    WITH base AS (
      SELECT p."id", p."brandId", p."categoryId", p."productTypeId", p."attributes",
             (${and(brandConditions(filters))}) AS "f_brand",
             (${and(categoryConditions(filters))}) AS "f_category",
             (${bounds.length ? activeVariantExists(bounds) : Prisma.sql`TRUE`}) AS "f_price",
             (${stockFlag}) AS "f_stock",
             (${stockAnyPriceFlag}) AS "f_stock_any",
             (${activeVariantExists([...bounds, sellable])}) AS "f_sellable"
             ${attributes.length ? Prisma.sql`, ${Prisma.join(attributes.map((filter, i) => Prisma.sql`(${attributeCondition(filter)}) AS ${Prisma.raw(`"f_a${i}"`)}`))}` : Prisma.empty}
      FROM "Product" p ${where([...unfacetedConditions(filters), ...(textCondition ? [textCondition] : [])])}
    ),
    attribute_values AS (
      -- Spellings differing in case are one value, shown in its byte-wise first spelling ("Cotton" over "cotton").
      SELECT av."key", min(av."value" COLLATE "C") AS "value", count(DISTINCT b."id")::int AS "count",
             min(av."position") AS "position", min(av."label") AS "label"
      FROM base b
      JOIN LATERAL (
        SELECT d."key", d."label", d."position", kv."value"
        FROM "AttributeDefinition" d
        CROSS JOIN LATERAL (
          SELECT b."attributes" ->> d."key" AS "value" WHERE NOT d."isVariantAxis"
          UNION
          SELECT v."optionValues" ->> d."key" FROM "Variant" v
          WHERE d."isVariantAxis" AND v."productId" = b."id" AND v."isActive"
        ) kv
        WHERE d."productTypeId" = b."productTypeId" AND d."isFilterable" AND kv."value" IS NOT NULL
      ) av ON TRUE
      WHERE ${flags.brand} AND ${flags.category} AND ${flags.price} AND ${flags.stock} AND ${attributeExcept}
      GROUP BY av."key", lower(av."value")
    ),
    attribute_keys AS (
      SELECT "key", min("position") AS "position", min("label") AS "label" FROM attribute_values
      GROUP BY "key" ORDER BY min("position"), "key" LIMIT ${FACET_ATTRIBUTES_LIMIT}
    ),
    ranked_values AS (
      SELECT v."key", v."value", v."count",
             row_number() OVER (PARTITION BY v."key" ORDER BY v."count" DESC, v."value") AS "rank"
      FROM attribute_values v JOIN attribute_keys k ON k."key" = v."key"
    )
    SELECT
      (SELECT count(*) FROM base b
       WHERE ${and([flags.brand, flags.category, flags.price, flags.stock, ...allAttributes])})::int AS "totalCount",
      (SELECT count(*) FROM base b
       WHERE ${and([flags.brand, flags.category, flags.price, Prisma.sql`b."f_sellable"`, ...allAttributes])})::int
        AS "inStockCount",
      (SELECT json_build_object('min', min(v."price")::text, 'max', max(v."price")::text)
       FROM base b JOIN "Variant" v ON v."productId" = b."id" AND v."isActive" AND v."price" IS NOT NULL ${priceVariants}
       WHERE ${and([flags.brand, flags.category, Prisma.sql`b."f_stock_any"`, ...allAttributes])}) AS "price",
      COALESCE((SELECT json_agg(json_build_object('id', x."id", 'name', x."name", 'count', x."count")
                                ORDER BY x."count" DESC, x."name", x."id")
                FROM (SELECT br."id", br."name", count(*)::int AS "count" FROM base b JOIN "Brand" br ON br."id" = b."brandId"
                      WHERE ${and([flags.category, flags.price, flags.stock, ...allAttributes])}
                      GROUP BY br."id", br."name" ORDER BY count(*) DESC, br."name", br."id" LIMIT ${limitValues}) x),
               '[]'::json) AS "brands",
      COALESCE((SELECT json_agg(json_build_object('id', x."id", 'name', x."name", 'count', x."count")
                                ORDER BY x."count" DESC, x."name", x."id")
                FROM (SELECT c."id", c."name", count(*)::int AS "count" FROM base b JOIN "Category" c ON c."id" = b."categoryId"
                      WHERE ${and([flags.brand, flags.price, flags.stock, ...allAttributes])}
                      GROUP BY c."id", c."name" ORDER BY count(*) DESC, c."name", c."id" LIMIT ${limitValues}) x),
               '[]'::json) AS "categories",
      COALESCE((SELECT json_agg(json_build_object('key', k."key", 'label', k."label", 'values', (
                  SELECT json_agg(json_build_object('value', r."value", 'count', r."count") ORDER BY r."rank")
                  FROM ranked_values r WHERE r."key" = k."key" AND r."rank" <= ${limitValues}
                )) ORDER BY k."position", k."key")
                FROM attribute_keys k), '[]'::json) AS "attributes"`;
}

export function where(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

/** The sort key of p as SQL; the relevance needs the text match. */
export function sortKey(key: ProductSortKey, score: Prisma.Sql | undefined): Prisma.Sql {
  if (key === 'RELEVANCE') {
    if (!score) throw new Error('RELEVANCE sort needs a text match');
    return score;
  }
  if (key === 'NAME') return Prisma.sql`p."name"`;
  return key === 'CREATED_AT' ? Prisma.sql`p."createdAt"` : Prisma.sql`p."updatedAt"`;
}

function cursorKey(cursor: SearchCursor): Prisma.Sql {
  if (cursor.sort === 'RELEVANCE') return Prisma.sql`${cursor.key}::float8`;
  if (cursor.sort === 'NAME') return Prisma.sql`${cursor.key}::text`;
  return Prisma.sql`${cursor.key}::timestamp(3)`;
}

/** Rows after the cursor in the order key `direction`, id ascending. */
function afterCursor(cursor: SearchCursor | undefined, direction: SortDirection): Prisma.Sql {
  if (!cursor) return Prisma.empty;
  const key = cursorKey(cursor);
  const beyond = direction === 'DESC' ? Prisma.sql`m."k" < ${key}` : Prisma.sql`m."k" > ${key}`;
  return Prisma.sql`WHERE (${beyond} OR (m."k" = ${key} AND m."id" > ${cursor.id}))`;
}

/**
 * One statement for a page: the total number of matches (ignoring the cursor) and up to `limit` rows after the
 * cursor as JSON [{id, k}], ordered by the key then id, so ties never repeat or skip a row between pages.
 */
export function pageQuery(args: {
  conditions: Prisma.Sql[];
  key: Prisma.Sql;
  direction: SortDirection;
  cursor?: SearchCursor;
  limit: number;
}): Prisma.Sql {
  const order = args.direction === 'DESC' ? Prisma.sql`DESC` : Prisma.sql`ASC`;
  return Prisma.sql`
    WITH matched AS (SELECT p."id", ${args.key} AS "k" FROM "Product" p ${where(args.conditions)})
    SELECT (SELECT count(*) FROM matched)::int AS "total",
           COALESCE((
             SELECT json_agg(json_build_object('id', page."id", 'k', page."k") ORDER BY page."k" ${order}, page."id")
             FROM (SELECT m."id", m."k" FROM matched m ${afterCursor(args.cursor, args.direction)}
                   ORDER BY m."k" ${order}, m."id" LIMIT ${args.limit}) page
           ), '[]'::json) AS "rows"`;
}

/** The text as a LIKE pattern matching it anywhere, its wildcards escaped. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

const PUBLISHED_PRODUCT = Prisma.sql`p."isActive" AND p."status" = 'PUBLISHED'`;

/**
 * Autocomplete in one statement (run with the fuzzy threshold set): names containing the prefix (trigram index) or
 * resembling it by word similarity (typos). Names starting with the prefix come first, then by similarity, name, id.
 * Brands and categories only when they have a published product.
 */
export function suggestionQuery(prefix: string, limit: number): Prisma.Sql {
  const pattern = containsPattern(prefix);
  const startsWith = pattern.slice(1);
  const suggestions = (table: string, extra: Prisma.Sql) => {
    const alias = Prisma.raw(`"${table}"`);
    return Prisma.sql`COALESCE((
      SELECT json_agg(json_build_object('id', s."id", 'name', s."name") ORDER BY s."rank")
      FROM (
        SELECT x."id", x."name", row_number() OVER (
                 ORDER BY (x."name" ILIKE ${startsWith}) DESC, word_similarity(${prefix}, x."name") DESC, x."name", x."id"
               ) AS "rank"
        FROM ${alias} x
        WHERE (x."name" ILIKE ${pattern} OR ${prefix} <% x."name") AND ${extra}
        ORDER BY "rank" LIMIT ${limit}
      ) s
    ), '[]'::json)`;
  };
  const hasPublished = (column: string) =>
    Prisma.sql`EXISTS (SELECT 1 FROM "Product" p WHERE p.${Prisma.raw(`"${column}"`)} = x."id" AND ${PUBLISHED_PRODUCT})`;
  return Prisma.sql`SELECT
    ${suggestions('Product', Prisma.sql`x."isActive" AND x."status" = 'PUBLISHED'`)} AS "products",
    ${suggestions('Brand', hasPublished('brandId'))} AS "brands",
    ${suggestions('Category', hasPublished('categoryId'))} AS "categories"`;
}

export function existsQuery(conditions: Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (SELECT 1 FROM "Product" p ${where(conditions)}) AS "found"`;
}
