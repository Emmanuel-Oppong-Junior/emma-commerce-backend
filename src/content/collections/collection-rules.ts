import { Prisma } from '../../generated/prisma/client';
import { PaginationArgs } from '../../commons/dto/paginate.args';
import { ProductSortArgs } from '../../products/dto/product-sort.args';
import { ProductSearchFilters, ProductSearchRequest } from '../../products/search/product-search.port';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  searchFiltersProblem,
  toSearchSort,
} from '../../products/search/product-search-request';

// The rules of a RULE collection, as stored in Collection.rules, and how a collection becomes a product search. Pure.

/** Stored JSON: only the rules set; prices as 2-decimal strings. */
export interface CollectionRules {
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
  tagId?: string;
  productTypeId?: string;
  priceMin?: string;
  priceMax?: string;
  onSale?: boolean;
  inStock?: boolean;
}

export interface CollectionRulesValues {
  categoryId?: string | null;
  subcategoryId?: string | null;
  brandId?: string | null;
  tagId?: string | null;
  productTypeId?: string | null;
  priceMin?: Prisma.Decimal | null;
  priceMax?: Prisma.Decimal | null;
  onSale?: boolean | null;
  inStock?: boolean | null;
}

const ID_RULES = ['categoryId', 'subcategoryId', 'brandId', 'tagId', 'productTypeId'] as const;
const FLAG_RULES = ['onSale', 'inStock'] as const;

/** The rules that are set, in their stored form. */
export function toCollectionRules(values: CollectionRulesValues): CollectionRules {
  const rules: CollectionRules = {};
  for (const key of ID_RULES) {
    const value = values[key];
    if (value != null) rules[key] = value;
  }
  if (values.priceMin != null) rules.priceMin = values.priceMin.toFixed(2);
  if (values.priceMax != null) rules.priceMax = values.priceMax.toFixed(2);
  for (const key of FLAG_RULES) {
    const value = values[key];
    if (value != null) rules[key] = value;
  }
  return rules;
}

/** The public product search of the rules: published products only, every rule its own filter. */
export function ruleFilters(rules: CollectionRules): ProductSearchFilters {
  return {
    visibility: 'PUBLIC',
    categoryId: rules.categoryId,
    subcategoryId: rules.subcategoryId,
    brandId: rules.brandId,
    tagId: rules.tagId,
    productTypeId: rules.productTypeId,
    priceMin: rules.priceMin === undefined ? undefined : new Prisma.Decimal(rules.priceMin),
    priceMax: rules.priceMax === undefined ? undefined : new Prisma.Decimal(rules.priceMax),
    onSale: rules.onSale,
    inStock: rules.inStock,
  };
}

/** Why the rules cannot make a collection, or null: at least one rule, and what the product list refuses. */
export function rulesProblem(rules: CollectionRules): string | null {
  if (Object.keys(rules).length === 0) return 'A rule-based collection needs at least one rule';
  return searchFiltersProblem(ruleFilters(rules));
}

export interface SearchableCollection {
  id: string;
  type: 'MANUAL' | 'RULE';
  rules: unknown;
}

/**
 * The product search for a page of the collection. MANUAL: its products, in the staff order unless a sort is asked
 * for; RULE: the products matching its rules, newest first unless a sort is asked for.
 */
export function collectionSearchRequest(
  collection: SearchableCollection,
  paginate: PaginationArgs,
  sort: ProductSortArgs,
): ProductSearchRequest {
  const filters: ProductSearchFilters =
    collection.type === 'MANUAL'
      ? { visibility: 'PUBLIC', collectionId: collection.id }
      : ruleFilters(collection.rules as CollectionRules);
  return {
    filters,
    sort:
      collection.type === 'MANUAL' && !sort.sortBy
        ? { key: 'POSITION', direction: 'ASC' }
        : toSearchSort(sort, filters),
    first: Math.min(paginate.first || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
    after: paginate.after || undefined,
  };
}
