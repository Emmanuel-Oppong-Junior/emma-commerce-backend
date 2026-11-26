import { HOMEPAGE_KEY, SLUGS_KEY, boundSurrogateKeys } from './surrogate-keys';

/**
 * Short on purpose: stock, prices and scheduled promotions also change without an event (or before the purge lands),
 * so a cached catalogue response is never more than this (plus the revalidation window) out of date.
 */
export const CATALOGUE_MAX_AGE_SECONDS = 60;
export const STALE_WHILE_REVALIDATE_SECONDS = 30;
export const UNCACHEABLE = 'private, no-store';

/**
 * Anonymous catalogue queries a CDN may cache, with the surrogate keys each adds beyond the objects it returns. A root
 * field not listed here is never publicly cacheable (Apollo's default max-age for root fields is 0).
 */
export const PUBLIC_ROOT_FIELDS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    products: ['products'],
    product: [],
    productBySlug: [],
    productFacets: ['products', 'categories', 'brands'],
    searchSuggestions: ['products', 'categories', 'brands'],
    categories: [],
    category: [],
    categoryBySlug: [],
    subCategories: [],
    subCategory: [],
    subCategoryBySlug: [],
    brands: [],
    brand: [],
    brandBySlug: [],
    collections: [],
    collection: [],
    banners: [],
    homepage: [HOMEPAGE_KEY],
    storeFeatures: [],
    loyaltySettings: [],
    resolveSlug: [SLUGS_KEY],
    resolvePath: [SLUGS_KEY],
  }),
);

/**
 * Object types whose fields are as public as the query that reaches them (they get the catalogue max-age). A type not
 * listed (Review, PriceChangePage, VariantStockLevel, Cart, ...) makes any response that selects it uncacheable.
 */
export const PUBLIC_TYPES: ReadonlySet<string> = new Set([
  'ProductConnection',
  'ProductEdge',
  'PageInfo',
  'Product',
  'Variant',
  'PriceRange',
  'Money',
  'PublicPromotion',
  'ProductRating',
  'RatingBucket',
  'ProductType',
  'AttributeDefinition',
  'Tag',
  'Category',
  'SubCategory',
  'Brand',
  'ProductFacets',
  'AttributeFacet',
  'AttributeFacetValue',
  'FacetCount',
  'SearchSuggestions',
  'Suggestion',
  'Collection',
  'CollectionRules',
  'HomepageBlock',
  'Banner',
  'BannerLink',
  'StoreFeature',
  'LoyaltySettingsEntity',
  'SlugResolution',
  'PathResolution',
]);

/** Fields that depend on who is asking: a response selecting one is never public, even for a visitor. */
export const PRIVATE_FIELDS: ReadonlySet<string> = new Set(['Variant.customerPrice', 'Variant.priceTiers']);

export interface CacheDecisionInput {
  method: string | undefined;
  /** Any Authorization header, valid or not. */
  hasAuthorization: boolean;
  operationType: string | undefined;
  /** Apollo's overall policy (policyIfCacheable): null when some field has max-age 0. */
  policy: { maxAge: number; scope: 'PUBLIC' | 'PRIVATE' } | null;
  hasErrors: boolean;
  surrogateKeys: Iterable<string>;
}

export type CacheDecision =
  | { cacheable: true; cacheControl: string; surrogateKeys: string[] }
  | { cacheable: false; cacheControl: typeof UNCACHEABLE };

/**
 * A response is public only when it is an anonymous GET query without errors and every field in it is PUBLIC with a
 * max-age; anything else is `private, no-store`.
 */
export function cacheDecision(input: CacheDecisionInput): CacheDecision {
  const { policy } = input;
  if (
    input.method !== 'GET' ||
    input.hasAuthorization ||
    input.operationType !== 'query' ||
    input.hasErrors ||
    !policy ||
    policy.scope !== 'PUBLIC' ||
    policy.maxAge <= 0
  ) {
    return { cacheable: false, cacheControl: UNCACHEABLE };
  }
  return {
    cacheable: true,
    cacheControl: `public, max-age=${policy.maxAge}, stale-while-revalidate=${STALE_WHILE_REVALIDATE_SECONDS}`,
    surrogateKeys: boundSurrogateKeys(input.surrogateKeys),
  };
}
