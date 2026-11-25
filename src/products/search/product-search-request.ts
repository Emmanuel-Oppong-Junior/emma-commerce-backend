import { ProductFilterArgs } from '../dto/product-filter.args';
import { ProductSortArgs } from '../dto/product-sort.args';
import { ProductSortField } from '../enums/product-sort-field.enum';
import { SortOrder } from '../../commons/enums/sort-order.enum';
import { PaginationArgs } from '../../commons/dto/paginate.args';
import { ProductSearchFilters, ProductSearchRequest, ProductSortKey, SearchVisibility } from './product-search.port';

// Turns the GraphQL arguments of a product list into a search request. Pure: the service throws on a problem.

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;
const HAS_WORD = /[\p{L}\p{N}]/u;

const SORT_KEYS: Record<ProductSortField, ProductSortKey> = {
  [ProductSortField.RELEVANCE]: 'RELEVANCE',
  [ProductSortField.NAME]: 'NAME',
  [ProductSortField.CREATED_AT]: 'CREATED_AT',
  [ProductSortField.UPDATED_AT]: 'UPDATED_AT',
};

/** Search text worth searching for: trimmed, and blank or punctuation-only text is no search at all. */
export function searchText(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  return text && HAS_WORD.test(text) ? text : undefined;
}

export function toSearchFilters(filter: ProductFilterArgs, visibility: SearchVisibility): ProductSearchFilters {
  return {
    visibility,
    ...(visibility === 'ADMIN' && { isActive: filter.isActive, status: filter.status }),
    text: searchText(filter.search),
    categoryId: filter.categoryId,
    categoryName: filter.categoryName,
    subcategoryId: filter.subcategoryId,
    subCategoryName: filter.subCategoryName,
    brandId: filter.brandId,
    brandName: filter.brand,
    tagId: filter.tagId,
    tagName: filter.tagName,
    productTypeId: filter.productTypeId,
    createdAfter: filter.createdAfter ? new Date(filter.createdAfter) : undefined,
    priceMin: filter.priceMin,
    priceMax: filter.priceMax,
    inStock: filter.inStock,
    attributes: filter.attributes?.map(({ key, values }) => ({ key, values: [...new Set(values)] })),
  };
}

/** Why the filters cannot be searched, or null. */
export function searchFiltersProblem(filters: ProductSearchFilters): string | null {
  if (filters.priceMin && filters.priceMax && filters.priceMin.greaterThan(filters.priceMax)) {
    return `priceMin ${filters.priceMin.toFixed(2)} is above priceMax ${filters.priceMax.toFixed(2)}`;
  }
  const keys = (filters.attributes ?? []).map((filter) => filter.key);
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated) return `Attribute "${repeated}" is filtered twice; put all its values in one filter`;
  return null;
}

/**
 * Without sortBy, a text search lists the best matches first and a plain list the newest first. RELEVANCE is always
 * best first; without search text it falls back to the newest first.
 */
export function toSearchSort(sort: ProductSortArgs, filters: ProductSearchFilters): ProductSearchRequest['sort'] {
  const field = sort.sortBy ?? (filters.text ? ProductSortField.RELEVANCE : ProductSortField.CREATED_AT);
  if (field === ProductSortField.RELEVANCE) {
    return filters.text ? { key: 'RELEVANCE', direction: 'DESC' } : { key: 'CREATED_AT', direction: 'DESC' };
  }
  return { key: SORT_KEYS[field], direction: (sort.sortOrder ?? SortOrder.DESC) === SortOrder.ASC ? 'ASC' : 'DESC' };
}

export function toSearchRequest(
  visibility: SearchVisibility,
  paginate: PaginationArgs,
  filter: ProductFilterArgs,
  sort: ProductSortArgs,
): ProductSearchRequest {
  const filters = toSearchFilters(filter, visibility);
  return {
    filters,
    sort: toSearchSort(sort, filters),
    first: Math.min(paginate.first || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    after: paginate.after || undefined,
  };
}
