/**
 * Surrogate keys (CDN cache tags): what a cached catalogue response depends on, and what a catalogue change purges.
 * Vocabulary:
 * - `catalogue`: on every public response; purged by store-wide changes (promotions, store settings, features).
 * - `<entity>:<id>` (e.g. `product:ck...`): the response shows that object.
 * - a family key (e.g. `products`): the response lists objects of that kind, so any change of the kind can alter it.
 *   Every change of an entity purges its family key, so a family key also stands in for entity keys that did not fit.
 * - `homepage`, `slugs`: the homepage layout and slug/path resolution.
 */

export const CATALOGUE_KEY = 'catalogue';
export const HOMEPAGE_KEY = 'homepage';
export const SLUGS_KEY = 'slugs';

/** At most this many keys per response; above it entity keys collapse into their family keys. */
export const MAX_SURROGATE_KEYS = 64;

/** GraphQL object types that carry an entity key, keyed by type name. */
export const TAGGED_TYPES = {
  Product: { prefix: 'product', family: 'products' },
  Category: { prefix: 'category', family: 'categories' },
  SubCategory: { prefix: 'subcategory', family: 'categories' },
  Brand: { prefix: 'brand', family: 'brands' },
  Tag: { prefix: 'tag', family: 'tags' },
  ProductType: { prefix: 'product-type', family: 'product-types' },
  Collection: { prefix: 'collection', family: 'collections' },
  Banner: { prefix: 'banner', family: 'banners' },
} as const;

export type TaggedTypeName = keyof typeof TAGGED_TYPES;

const FAMILY_BY_PREFIX: ReadonlyMap<string, string> = new Map(
  Object.values(TAGGED_TYPES).map(({ prefix, family }) => [prefix, family]),
);

// Ids end up in a space- or comma-separated header; anything else falls back to the family key.
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isTaggedType(typeName: string): typeName is TaggedTypeName {
  return Object.prototype.hasOwnProperty.call(TAGGED_TYPES, typeName);
}

export function familyKey(typeName: TaggedTypeName): string {
  return TAGGED_TYPES[typeName].family;
}

/** The key for one object of a tagged type: its entity key, or its family key when the id is missing or unusable. */
export function objectKey(typeName: TaggedTypeName, id: unknown): string {
  const { prefix, family } = TAGGED_TYPES[typeName];
  return typeof id === 'string' && SAFE_ID.test(id) ? `${prefix}:${id}` : family;
}

/**
 * The header-ready key list: `catalogue` first, then the collected keys sorted. When more than MAX_SURROGATE_KEYS,
 * every entity key is replaced by its family key (a purge of any entity also purges its family, so nothing is lost).
 */
export function boundSurrogateKeys(collected: Iterable<string>): string[] {
  const keys = new Set(collected);
  keys.delete(CATALOGUE_KEY);
  let bounded = [...keys];
  if (bounded.length + 1 > MAX_SURROGATE_KEYS) {
    bounded = [...new Set(bounded.map((key) => FAMILY_BY_PREFIX.get(key.split(':')[0]) ?? key))];
  }
  return [CATALOGUE_KEY, ...bounded.sort()];
}

/** What changed, as recorded by the database triggers in catalogue.changed.v1 (migration 20261221100000). */
export const CATALOGUE_CHANGE_REASONS = [
  'product',
  'stock',
  'category',
  'subcategory',
  'brand',
  'tag',
  'product-type',
  'collection',
  'banner',
  'homepage',
  'redirect',
  'store',
  'store-feature',
  'promotion',
  'stock-location',
] as const;

export type CatalogueChangeReason = (typeof CATALOGUE_CHANGE_REASONS)[number];

export function isCatalogueChangeReason(value: unknown): value is CatalogueChangeReason {
  return typeof value === 'string' && (CATALOGUE_CHANGE_REASONS as readonly string[]).includes(value);
}

const ENTITY_REASONS: Partial<Record<CatalogueChangeReason, { type: TaggedTypeName; also: string[] }>> = {
  product: { type: 'Product', also: [SLUGS_KEY] },
  stock: { type: 'Product', also: [] },
  category: { type: 'Category', also: [SLUGS_KEY] },
  subcategory: { type: 'SubCategory', also: [SLUGS_KEY] },
  brand: { type: 'Brand', also: [SLUGS_KEY] },
  // Product lists filter by tag name and attribute definitions.
  tag: { type: 'Tag', also: ['products'] },
  'product-type': { type: 'ProductType', also: ['products'] },
  collection: { type: 'Collection', also: [SLUGS_KEY] },
  banner: { type: 'Banner', also: [] },
};

/**
 * The keys to purge for one recorded change. `ids` null means "too many to list" (the trigger caps them), and a
 * store-wide reason ignores ids: both purge everything, since entity keys on detail pages have no family key.
 */
export function purgeKeysFor(reason: CatalogueChangeReason, ids: readonly string[] | null): string[] {
  if (reason === 'homepage') return [HOMEPAGE_KEY];
  if (reason === 'redirect') return [SLUGS_KEY];
  const entity = ENTITY_REASONS[reason];
  if (!entity || ids === null) return [CATALOGUE_KEY];
  const keys = new Set([...ids.map((id) => objectKey(entity.type, id)), familyKey(entity.type), ...entity.also]);
  return [...keys];
}
