import { ImportKind, ImportRowAction, Prisma } from '../../generated/prisma/client';
import { TableRow } from '../spreadsheet/table-reader';
import { duplicateKeyErrors, ImportColumns, ParsedRow, RowOutcome } from './import-rows';
import {
  CatalogueFacts,
  planProductGroup,
  PRODUCT_COLUMNS,
  PRODUCT_TEMPLATE_EXAMPLE,
  productTarget,
} from './products-import';
import { planPriceRow, PRICE_COLUMNS, PRICE_TEMPLATE_EXAMPLE, VariantPriceFacts } from './prices-import';
import {
  LocationFacts,
  planStockRow,
  resolveLocation,
  STOCK_COLUMNS,
  STOCK_TEMPLATE_EXAMPLE,
  StockLevelFacts,
  StockVariantFacts,
} from './stock-import';

export const IMPORT_COLUMNS: Record<ImportKind, ImportColumns> = {
  [ImportKind.PRODUCTS]: PRODUCT_COLUMNS,
  [ImportKind.PRICES]: PRICE_COLUMNS,
  [ImportKind.STOCK]: STOCK_COLUMNS,
};

const TEMPLATE_EXAMPLES: Record<ImportKind, Record<string, string>> = {
  [ImportKind.PRODUCTS]: PRODUCT_TEMPLATE_EXAMPLE,
  [ImportKind.PRICES]: PRICE_TEMPLATE_EXAMPLE,
  [ImportKind.STOCK]: STOCK_TEMPLATE_EXAMPLE,
};

/** The downloadable template of a kind: every column, and one example row. */
export function importTemplate(kind: ImportKind): { header: string[]; example: string[] } {
  const header = [...IMPORT_COLUMNS[kind].required, ...IMPORT_COLUMNS[kind].optional];
  return { header, example: header.map((column) => TEMPLATE_EXAMPLES[kind][column] ?? '') };
}

const invalid = (...errors: string[]): RowOutcome => ({ errors, warnings: [], action: ImportRowAction.NONE });
const outcomeOf = ({ errors, warnings, action }: RowOutcome): RowOutcome => ({ errors, warnings, action });

/** Row-level problems every kind shares: cells beyond the header, and keys an earlier row already used. */
function fileLevelErrors(rows: readonly TableRow[], duplicates: Map<number, string>): Map<number, string[]> {
  const errors = new Map<number, string[]>();
  for (const row of rows) {
    const found = [
      ...(row.extraCells > 0 ? [`The row has ${row.extraCells} value(s) beyond the last named column`] : []),
      ...(duplicates.has(row.rowNumber) ? [duplicates.get(row.rowNumber)!] : []),
    ];
    if (found.length) errors.set(row.rowNumber, found);
  }
  return errors;
}

const skuKey = (row: ParsedRow) => row.values.sku?.toLowerCase();
const describeSku = (row: ParsedRow) => `SKU "${row.values.sku}"`;

export function validateProductRows(rows: readonly TableRow[], facts: CatalogueFacts): Map<number, RowOutcome> {
  const duplicates = duplicateKeyErrors(rows, skuKey, describeSku);
  for (const [rowNumber, error] of duplicateKeyErrors(
    rows,
    (row) => row.values.barcode,
    (row) => `Barcode "${row.values.barcode}"`,
  )) {
    if (!duplicates.has(rowNumber)) duplicates.set(rowNumber, error);
  }
  const rejected = fileLevelErrors(rows, duplicates);
  const outcomes = new Map<number, RowOutcome>();
  const groups = new Map<string, ParsedRow[]>();
  for (const row of rows) {
    const errors = rejected.get(row.rowNumber);
    if (errors) outcomes.set(row.rowNumber, invalid(...errors));
    else {
      const target = productTarget(row.values, facts.variantsBySku);
      groups.set(target, [...(groups.get(target) ?? []), row]);
    }
  }
  for (const group of groups.values()) {
    for (const [rowNumber, outcome] of planProductGroup(group, facts).rows) outcomes.set(rowNumber, outcome);
  }
  return outcomes;
}

export function validatePriceRows(
  rows: readonly TableRow[],
  variants: Map<string, VariantPriceFacts>,
  taxRate: Prisma.Decimal,
): Map<number, RowOutcome> {
  const rejected = fileLevelErrors(rows, duplicateKeyErrors(rows, skuKey, describeSku));
  return new Map(
    rows.map((row) => {
      const errors = rejected.get(row.rowNumber);
      if (errors) return [row.rowNumber, invalid(...errors)];
      return [row.rowNumber, outcomeOf(planPriceRow(row.values, variants.get(skuKey(row) ?? ''), taxRate))];
    }),
  );
}

export function validateStockRows(
  rows: readonly TableRow[],
  variants: Map<string, StockVariantFacts>,
  locations: readonly LocationFacts[],
  levels: Map<string, StockLevelFacts>,
): Map<number, RowOutcome> {
  const duplicates = duplicateKeyErrors(
    rows,
    (row) => {
      const location = resolveLocation(row.values.location, locations);
      return row.values.sku && 'id' in location ? `${skuKey(row)}@${location.id}` : undefined;
    },
    (row) => `SKU "${row.values.sku}" at this location`,
  );
  const rejected = fileLevelErrors(rows, duplicates);
  return new Map(
    rows.map((row) => {
      const errors = rejected.get(row.rowNumber);
      if (errors) return [row.rowNumber, invalid(...errors)];
      const variant = variants.get(skuKey(row) ?? '');
      const location = resolveLocation(row.values.location, locations);
      const level = variant && 'id' in location ? (levels.get(`${variant.id}@${location.id}`) ?? null) : null;
      return [row.rowNumber, outcomeOf(planStockRow(row.values, variant, locations, level))];
    }),
  );
}
