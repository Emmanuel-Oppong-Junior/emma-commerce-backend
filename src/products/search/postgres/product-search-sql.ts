import { Prisma } from '../../../generated/prisma/client';
import { SERVING_LOCATION_SQL } from '../../../inventory/locations/serving-locations';
import { expiredLotUnitsSql } from '../../../inventory/lots/lot-stock.repository';
import { ProductSearchFilters, ProductSortKey, SortDirection } from '../product-search.port';
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
 * Whether p matches the search text, and its relevance (higher is better) as float8. FUZZY: every word must be
 * similar to a part of the name (index-backed <% operator); relevance is the mean similarity.
 */
export function textMatch(text: string, mode: TextMatchMode): { condition: Prisma.Sql; score: Prisma.Sql } {
  if (mode === 'FTS') {
    const query = tsQuery(text);
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

/** Every filter except the search text, each its own condition, so no filter can replace another. */
export function filterConditions(filters: ProductSearchFilters, now: Date): Prisma.Sql[] {
  const conditions = visibilityConditions(filters);
  if (filters.categoryId) conditions.push(Prisma.sql`p."categoryId" = ${filters.categoryId}`);
  if (filters.categoryName) conditions.push(nameIs('Category', 'categoryId', filters.categoryName));
  if (filters.subcategoryId) conditions.push(Prisma.sql`p."subcategoryId" = ${filters.subcategoryId}`);
  if (filters.subCategoryName) conditions.push(nameIs('SubCategory', 'subcategoryId', filters.subCategoryName));
  if (filters.brandId) conditions.push(Prisma.sql`p."brandId" = ${filters.brandId}`);
  if (filters.brandName) conditions.push(nameIs('Brand', 'brandId', filters.brandName));
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
  conditions.push(...variantConditions(filters, now));
  return conditions;
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

export function existsQuery(conditions: Prisma.Sql[]): Prisma.Sql {
  return Prisma.sql`SELECT EXISTS (SELECT 1 FROM "Product" p ${where(conditions)}) AS "found"`;
}
