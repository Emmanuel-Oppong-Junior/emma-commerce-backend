import { Prisma } from '../../generated/prisma/client';

// The search port of ADR-0010: the products module asks it which products match and in what order, then loads them
// itself. The Postgres adapter is the only one today; a Meilisearch adapter would implement the same contract.

/** PUBLIC: only active, PUBLISHED products. ADMIN: any, narrowed by isActive/status when given. */
export type SearchVisibility = 'PUBLIC' | 'ADMIN';

export type ProductSortKey = 'RELEVANCE' | 'NAME' | 'CREATED_AT' | 'UPDATED_AT';
export type SortDirection = 'ASC' | 'DESC';

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

export abstract class ProductSearch {
  abstract search(request: ProductSearchRequest): Promise<ProductSearchPage>;
}
