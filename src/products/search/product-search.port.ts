import { Prisma } from '../../generated/prisma/client';

// The search port of ADR-0010: the products module asks it which products match and in what order, then loads them
// itself. The Postgres adapter is the only one today; a Meilisearch adapter would implement the same contract.

/** PUBLIC: only active, PUBLISHED products. ADMIN: any, narrowed by isActive/status when given. */
export type SearchVisibility = 'PUBLIC' | 'ADMIN';

export type ProductSortKey = 'RELEVANCE' | 'NAME' | 'CREATED_AT' | 'UPDATED_AT';
export type SortDirection = 'ASC' | 'DESC';

/** Products whose attribute `key` (on the product, or a variant axis of an active variant) is one of `values`. */
export interface AttributeFilter {
  key: string;
  /** Compared ignoring case. */
  values: string[];
}

export interface ProductSearchFilters {
  visibility: SearchVisibility;
  /** ADMIN only. */
  isActive?: boolean;
  /** ADMIN only. */
  status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  /** Trimmed search text with at least one letter or digit; absent means no text search. */
  text?: string;
  categoryId?: string;
  categoryName?: string;
  subcategoryId?: string;
  subCategoryName?: string;
  brandId?: string;
  brandName?: string;
  tagId?: string;
  tagName?: string;
  productTypeId?: string;
  createdAfter?: Date;
  /** A product matches when one of its active variants is priced within the bounds (inclusive). */
  priceMin?: Prisma.Decimal;
  priceMax?: Prisma.Decimal;
  /** true: an active variant can be bought now; false: none can. With a price range, the same variant must match. */
  inStock?: boolean;
  /** AND across attributes, OR within one. */
  attributes?: AttributeFilter[];
}

export interface ProductSearchRequest {
  filters: ProductSearchFilters;
  sort: { key: ProductSortKey; direction: SortDirection };
  first: number;
  /** A cursor this port returned for the same filters and sort. */
  after?: string;
}

export interface ProductSearchPage {
  items: { id: string; cursor: string }[];
  hasNextPage: boolean;
  totalCount: number;
}

export interface FacetCount {
  id: string;
  name: string;
  count: number;
}

export interface AttributeFacet {
  key: string;
  label: string;
  values: { value: string; count: number }[];
}

/**
 * Counts for the products matching the filters. Each facet ignores its own filter (brands without the brand filter,
 * an attribute without that attribute's filter, the price range without the price bounds, the in-stock count
 * without inStock), so the other choices stay visible; with no such filter they count the result itself.
 */
export interface ProductFacets {
  totalCount: number;
  /** Products that would match with inStock: true. */
  inStockCount: number;
  /** Lowest and highest active variant price; null when no variant is priced. */
  price: { min: Prisma.Decimal; max: Prisma.Decimal } | null;
  brands: FacetCount[];
  categories: FacetCount[];
  /** Filterable attributes (AttributeDefinition.isFilterable) of the matching products' types. */
  attributes: AttributeFacet[];
}

export interface Suggestion {
  id: string;
  name: string;
}

/** Autocomplete for a typed prefix: published products, and brands and categories that have some. */
export interface SearchSuggestions {
  products: Suggestion[];
  brands: Suggestion[];
  categories: Suggestion[];
}

export abstract class ProductSearch {
  abstract search(request: ProductSearchRequest): Promise<ProductSearchPage>;
  abstract facets(filters: ProductSearchFilters): Promise<ProductFacets>;
  /** Up to `limit` of each kind whose name starts with, contains or (allowing typos) resembles the prefix. */
  abstract suggest(prefix: string, limit: number): Promise<SearchSuggestions>;
}
