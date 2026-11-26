import { ImportRowAction, Prisma, ProductStatus } from '../../generated/prisma/client';
import {
  AttributeMap,
  AttributeRule,
  checkOptionValues,
  checkProductAttributes,
  describeProblems,
} from '../../product-types/domain/attribute-validation';
import { sellingPrice } from '../../tax/tax-inclusive-price';
import {
  ImportColumns,
  ParsedRow,
  parseAmount,
  parseFlag,
  parseWholeNumber,
  RowOutcome,
  textProblem,
} from './import-rows';

export const ATTRIBUTE_PREFIX = 'attr.';
export const OPTION_PREFIX = 'option.';

const PRODUCT_FIELDS = [
  'name',
  'description',
  'short_description',
  'product_type',
  'category',
  'subcategory',
  'brand',
  'status',
  'is_taxable',
] as const;
type ProductField = (typeof PRODUCT_FIELDS)[number];

export const PRODUCT_COLUMNS: ImportColumns = {
  required: ['sku'],
  optional: [
    'product_id',
    'product_key',
    ...PRODUCT_FIELDS,
    'tags',
    'barcode',
    'base_price',
    'weight_grams',
    'low_stock_threshold',
    'is_active',
  ],
  prefixes: [ATTRIBUTE_PREFIX, OPTION_PREFIX],
};

export const PRODUCT_TEMPLATE_EXAMPLE: Record<string, string> = {
  sku: 'TSHIRT-RED-M',
  product_id: '',
  product_key: 'TSHIRT',
  name: 'Classic T-shirt',
  description: 'Soft cotton T-shirt',
  short_description: 'Cotton T-shirt',
  product_type: 'general',
  category: '',
  subcategory: '',
  brand: '',
  status: 'DRAFT',
  is_taxable: 'false',
  tags: '',
  barcode: '',
  base_price: '120.00',
  weight_grams: '200',
  low_stock_threshold: '5',
  is_active: 'true',
};

const LIMITS: Partial<Record<ProductField | 'sku' | 'barcode', number>> = {
  name: 255,
  short_description: 500,
  description: 20_000,
  sku: 100,
  barcode: 100,
};

export interface ProductTypeFacts {
  id: string;
  key: string;
  attributes: AttributeRule[];
}

export interface NamedFacts {
  id: string;
  name: string;
}

export interface ExistingVariant {
  id: string;
  sku: string;
  barcode: string | null;
  productId: string;
  optionsKey: string;
  optionValues: Prisma.JsonValue;
  isActive: boolean;
  basePrice: Prisma.Decimal | null;
  weightGrams: number | null;
  lowStockThreshold: number | null;
}

export interface ExistingProduct {
  id: string;
  name: string;
  description: string | null;
  shortDescription: string | null;
  productTypeId: string;
  isTaxable: boolean;
  status: ProductStatus | null;
  attributes: Prisma.JsonValue;
  categoryId: string | null;
  subcategoryId: string | null;
  brandId: string | null;
  tagIds: string[];
  variants: ExistingVariant[];
}

/** What the catalogue holds for the rows being checked (loaded in bulk for validation, per batch when applying). */
export interface CatalogueFacts {
  productTypes: ProductTypeFacts[];
  defaultProductTypeId: string;
  categories: NamedFacts[];
  subcategories: (NamedFacts & { categoryId: string })[];
  brands: NamedFacts[];
  tags: NamedFacts[];
  /** By lower-cased SKU */
  variantsBySku: Map<string, ExistingVariant>;
  products: Map<string, ExistingProduct>;
  /** Variant holding each barcode the rows name */
  barcodeOwners: Map<string, string>;
  taxRate: Prisma.Decimal;
}

export interface ProductData {
  name?: string;
  description?: string;
  shortDescription?: string;
  productTypeId?: string;
  attributes?: AttributeMap;
  isTaxable?: boolean;
  status?: ProductStatus;
  categoryId?: string;
  subcategoryId?: string;
  brandId?: string;
}

export interface VariantData {
  sku?: string;
  barcode?: string;
  optionValues?: AttributeMap;
  optionsKey?: string;
  basePrice?: Prisma.Decimal;
  price?: Prisma.Decimal;
  weightGrams?: number;
  lowStockThreshold?: number;
  isActive?: boolean;
}

export type VariantStep =
  | {
      rowNumber: number;
      kind: 'create';
      data: Required<Pick<VariantData, 'sku' | 'basePrice' | 'price'>> & VariantData;
    }
  | { rowNumber: number; kind: 'update'; id: string; data: VariantData };

export interface ProductGroupPlan {
  product:
    | { kind: 'create'; data: ProductData & { name: string; productTypeId: string } }
    | { kind: 'update'; id: string; data: ProductData };
  /** Tags to add (an import never removes tags) */
  tagIds: string[];
  variants: VariantStep[];
}

export interface GroupOutcome {
  rows: Map<number, RowOutcome>;
  plan?: ProductGroupPlan;
}

const lower = (text: string) => text.toLowerCase();
const byName = <T extends NamedFacts>(items: readonly T[], name: string) =>
  items.find((item) => lower(item.name) === lower(name));

/**
 * Which product a row belongs to: the product of its SKU when the SKU exists, the `product_id` given, or a new
 * product grouped by `product_key` (the SKU when blank). Rows of one target are checked and applied together.
 */
export function productTarget(
  values: Record<string, string>,
  variantsBySku: ReadonlyMap<string, { productId: string }>,
): string {
  const existing = values.sku ? variantsBySku.get(lower(values.sku)) : undefined;
  if (existing) return `product:${existing.productId}`;
  if (values.product_id) return `product:${values.product_id}`;
  return `new:${lower(values.product_key ?? values.sku ?? '')}`;
}

function collect(prefix: string, values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .filter(([column]) => column.startsWith(prefix))
      .map(([column, value]) => [column.slice(prefix.length), value]),
  );
}

function asObject(json: Prisma.JsonValue): Record<string, unknown> {
  return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Checks the rows of one product target and plans its writes, all or nothing: one invalid row fails every row of its
 * product. Blank cells leave a field as it is (an import cannot clear a field). Existing variants keep their price
 * (prices change through a PRICES import), their product's type and tax setting cannot change here, and tags are only
 * added. New variants need a base_price; their selling price follows the tax setting like any other variant.
 */
export function planProductGroup(rows: readonly ParsedRow[], facts: CatalogueFacts): GroupOutcome {
  const outcomes = new Map<number, RowOutcome>(
    rows.map((row) => [row.rowNumber, { errors: [], warnings: [], action: ImportRowAction.NONE }]),
  );
  const fail = (rowNumber: number, error: string) => outcomes.get(rowNumber)!.errors.push(error);
  const warn = (rowNumber: number, warning: string) => outcomes.get(rowNumber)!.warnings.push(warning);

  // Product-level cells: every non-blank value must agree across the group's rows.
  const merged: Partial<Record<ProductField, { value: string; rowNumber: number }>> = {};
  const attributeCells: Record<string, { value: string; rowNumber: number }> = {};
  const tagNames = new Map<string, number>();
  for (const row of rows) {
    for (const field of PRODUCT_FIELDS) {
      const value = row.values[field];
      if (value === undefined) continue;
      const earlier = merged[field];
      if (earlier && earlier.value !== value) {
        fail(row.rowNumber, `${field} "${value}" differs from row ${earlier.rowNumber} ("${earlier.value}")`);
      } else if (!earlier) merged[field] = { value, rowNumber: row.rowNumber };
      const limit = LIMITS[field];
      const problem = limit ? textProblem(field, value, limit) : null;
      if (problem) fail(row.rowNumber, problem);
    }
    for (const [key, value] of Object.entries(collect(ATTRIBUTE_PREFIX, row.values))) {
      const earlier = attributeCells[key];
      if (earlier && earlier.value !== value) {
        fail(row.rowNumber, `attr.${key} "${value}" differs from row ${earlier.rowNumber} ("${earlier.value}")`);
      } else if (!earlier) attributeCells[key] = { value, rowNumber: row.rowNumber };
    }
    for (const name of (row.values.tags ?? '').split('|').map((tag) => tag.trim())) {
      if (name && !tagNames.has(lower(name))) tagNames.set(lower(name), row.rowNumber);
    }
  }
  const firstRow = rows[0].rowNumber;
  const rowOf = (field: ProductField) => merged[field]?.rowNumber ?? firstRow;

  // The product: an existing one, or a new one.
  const existingVariant = rows
    .map((row) => (row.values.sku ? facts.variantsBySku.get(lower(row.values.sku)) : undefined))
    .find(Boolean);
  const existingId = existingVariant?.productId ?? rows.find((row) => row.values.product_id)?.values.product_id;
  const existing = existingId ? facts.products.get(existingId) : undefined;
  if (existingId && !existing) fail(firstRow, `No product has id "${existingId}"`);
  for (const row of rows) {
    const own = row.values.sku ? facts.variantsBySku.get(lower(row.values.sku)) : undefined;
    const productId = own?.productId ?? existingId;
    if (row.values.product_id && productId && row.values.product_id !== productId) {
      fail(row.rowNumber, `SKU "${row.values.sku}" belongs to product "${productId}", not "${row.values.product_id}"`);
    }
  }

  const data: ProductData = {};
  let productType: ProductTypeFacts | undefined;
  if (merged.product_type) {
    productType = facts.productTypes.find((type) => lower(type.key) === lower(merged.product_type!.value));
    if (!productType) fail(rowOf('product_type'), `No product type has key "${merged.product_type.value}"`);
    else if (existing && productType.id !== existing.productTypeId) {
      fail(
        rowOf('product_type'),
        'The product type of an existing product cannot change by import: change it in the admin',
      );
    }
  }
  productType ??= facts.productTypes.find(
    (type) => type.id === (existing?.productTypeId ?? facts.defaultProductTypeId),
  );
  if (!productType)
    throw new Error(`Product type "${existing?.productTypeId ?? facts.defaultProductTypeId}" is missing`);
  if (!existing) data.productTypeId = productType.id;

  if (merged.name) data.name = merged.name.value;
  else if (!existing) fail(firstRow, 'name is required for a new product');
  if (merged.description) data.description = merged.description.value;
  if (merged.short_description) data.shortDescription = merged.short_description.value;
  if (merged.status) {
    const status = merged.status.value.toUpperCase() as ProductStatus;
    if (Object.values(ProductStatus).includes(status)) data.status = status;
    else fail(rowOf('status'), `status must be one of ${Object.values(ProductStatus).join(', ')}`);
  }
  let isTaxable = existing?.isTaxable ?? false;
  if (merged.is_taxable) {
    const parsed = parseFlag('is_taxable', merged.is_taxable.value);
    if (!parsed.ok) fail(rowOf('is_taxable'), parsed.error);
    else if (existing && parsed.value !== existing.isTaxable) {
      fail(rowOf('is_taxable'), 'Changing is_taxable reprices every variant: change it in the admin');
    } else {
      isTaxable = parsed.value;
      if (!existing) data.isTaxable = parsed.value;
    }
  }

  let categoryId = existing?.categoryId ?? null;
  if (merged.category) {
    const category = byName(facts.categories, merged.category.value);
    if (!category) fail(rowOf('category'), `No category is called "${merged.category.value}"`);
    else categoryId = data.categoryId = category.id;
  }
  if (merged.subcategory) {
    const subcategory = facts.subcategories.find(
      (candidate) => lower(candidate.name) === lower(merged.subcategory!.value) && candidate.categoryId === categoryId,
    );
    if (!subcategory) {
      fail(rowOf('subcategory'), `The category has no sub-category called "${merged.subcategory.value}"`);
    } else data.subcategoryId = subcategory.id;
  } else if (data.categoryId && existing?.subcategoryId) {
    const current = facts.subcategories.find((candidate) => candidate.id === existing.subcategoryId);
    if (current && current.categoryId !== data.categoryId) {
      fail(rowOf('category'), "The product's sub-category belongs to another category: give a sub-category too");
    }
  }
  if (merged.brand) {
    const brand = byName(facts.brands, merged.brand.value);
    if (!brand) fail(rowOf('brand'), `No brand is called "${merged.brand.value}"`);
    else data.brandId = brand.id;
  }
  const tagIds: string[] = [];
  for (const [name, rowNumber] of tagNames) {
    const tag = byName(facts.tags, name);
    if (!tag) fail(rowNumber, `No tag is called "${name}"`);
    else if (!existing?.tagIds.includes(tag.id)) tagIds.push(tag.id);
  }

  if (Object.keys(attributeCells).length > 0 || !existing) {
    const input = {
      ...asObject(existing?.attributes ?? {}),
      ...Object.fromEntries(Object.entries(attributeCells).map(([key, cell]) => [key, cell.value])),
    };
    const checked = checkProductAttributes(productType.attributes, input);
    const attributeRow = Object.values(attributeCells)[0]?.rowNumber ?? firstRow;
    if (!checked.ok) fail(attributeRow, `Invalid attributes: ${describeProblems(checked.problems)}`);
    else if (!existing || !sameJson(checked.value, existing.attributes)) data.attributes = checked.value;
  }

  if (existing) {
    for (const key of [
      'name',
      'description',
      'shortDescription',
      'status',
      'categoryId',
      'subcategoryId',
      'brandId',
    ] as const) {
      if (data[key] !== undefined && data[key] === existing[key]) delete data[key];
    }
  }

  // Variants.
  const variants: VariantStep[] = [];
  const activeKeys = new Map<string, string>(
    (existing?.variants ?? []).filter((v) => v.isActive).map((v) => [v.id, v.optionsKey]),
  );
  for (const row of rows) {
    const v = row.values;
    const own = v.sku ? facts.variantsBySku.get(lower(v.sku)) : undefined;
    const step: VariantData = {};
    for (const column of ['sku', 'barcode'] as const) {
      const problem = textProblem(column, v[column], LIMITS[column]!);
      if (problem) fail(row.rowNumber, problem);
    }
    if (!v.sku) fail(row.rowNumber, 'sku is required');
    if (v.barcode && v.barcode !== own?.barcode) {
      const owner = facts.barcodeOwners.get(v.barcode);
      if (owner && owner !== own?.id)
        fail(row.rowNumber, `Barcode "${v.barcode}" is already used by variant "${owner}"`);
      else step.barcode = v.barcode;
    }
    for (const [column, key] of [
      ['weight_grams', 'weightGrams'],
      ['low_stock_threshold', 'lowStockThreshold'],
    ] as const) {
      if (v[column] === undefined) continue;
      const parsed = parseWholeNumber(column, v[column], { min: 0 });
      if (!parsed.ok) fail(row.rowNumber, parsed.error);
      else if (parsed.value !== own?.[key]) step[key] = parsed.value;
    }
    if (v.is_active !== undefined) {
      const parsed = parseFlag('is_active', v.is_active);
      if (!parsed.ok) fail(row.rowNumber, parsed.error);
      else if (parsed.value !== (own?.isActive ?? true)) step.isActive = parsed.value;
    }
    const optionCells = collect(OPTION_PREFIX, v);
    if (Object.keys(optionCells).length > 0 || !own) {
      const checked = checkOptionValues(productType.attributes, {
        ...asObject(own?.optionValues ?? {}),
        ...optionCells,
      });
      if (!checked.ok) fail(row.rowNumber, `Invalid options: ${describeProblems(checked.problems)}`);
      else if (
        !own ||
        checked.value.optionsKey !== own.optionsKey ||
        !sameJson(checked.value.values, own.optionValues)
      ) {
        step.optionValues = checked.value.values;
        step.optionsKey = checked.value.optionsKey;
      }
    }
    const willBeActive = step.isActive ?? own?.isActive ?? true;
    const key = step.optionsKey ?? own?.optionsKey ?? '';
    const slot = own?.id ?? `row:${row.rowNumber}`;
    activeKeys.delete(slot);
    if (willBeActive) {
      const clash = [...activeKeys].find(([, other]) => other === key)?.[0];
      if (clash) {
        fail(
          row.rowNumber,
          `Another active variant of the product (${clash.startsWith('row:') ? `row ${clash.slice(4)}` : clash}) has the same options (${key || 'none'})`,
        );
      }
      activeKeys.set(slot, key);
    }

    let basePrice: Prisma.Decimal | undefined;
    if (v.base_price !== undefined) {
      const parsed = parseAmount('base_price', v.base_price);
      if (!parsed.ok) fail(row.rowNumber, parsed.error);
      else basePrice = parsed.value;
    }
    if (own) {
      if (basePrice && !own.basePrice?.equals(basePrice)) {
        warn(row.rowNumber, 'base_price is ignored for an existing SKU: change prices with a PRICES import');
      }
      if (Object.keys(step).length > 0) {
        variants.push({ rowNumber: row.rowNumber, kind: 'update', id: own.id, data: step });
        outcomes.get(row.rowNumber)!.action = ImportRowAction.UPDATE;
      }
    } else if (!basePrice) {
      if (v.base_price === undefined) fail(row.rowNumber, 'base_price is required for a new SKU');
    } else if (v.sku) {
      const price = sellingPrice(basePrice, isTaxable, facts.taxRate);
      variants.push({ rowNumber: row.rowNumber, kind: 'create', data: { ...step, sku: v.sku, basePrice, price } });
      outcomes.get(row.rowNumber)!.action = ImportRowAction.CREATE;
    }
  }

  const productChanged = !existing || Object.keys(data).length > 0 || tagIds.length > 0;
  const firstOutcome = outcomes.get(firstRow)!;
  if (existing && productChanged && firstOutcome.action === ImportRowAction.NONE) {
    firstOutcome.action = ImportRowAction.UPDATE;
  }

  const invalid = rows.filter((row) => outcomes.get(row.rowNumber)!.errors.length > 0).map((row) => row.rowNumber);
  if (invalid.length > 0) {
    for (const row of rows) {
      const outcome = outcomes.get(row.rowNumber)!;
      if (outcome.errors.length === 0) {
        outcome.errors.push(
          `Row(s) ${invalid.join(', ')} of the same product are invalid, so this row is not imported`,
        );
      }
      outcome.action = ImportRowAction.NONE;
    }
    return { rows: outcomes };
  }
  const product: ProductGroupPlan['product'] = existing
    ? { kind: 'update', id: existing.id, data }
    : { kind: 'create', data: { ...data, name: data.name!, productTypeId: productType.id } };
  return { rows: outcomes, plan: { product, tagIds, variants } };
}
