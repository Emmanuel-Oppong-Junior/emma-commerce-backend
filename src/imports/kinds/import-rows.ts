import { ImportRowAction, Prisma } from '../../generated/prisma/client';

/** What validating (or re-checking before applying) one row found. */
export interface RowOutcome {
  errors: string[];
  warnings: string[];
  action: ImportRowAction;
}

export interface ImportColumns {
  required: readonly string[];
  optional: readonly string[];
  /** Column families such as `attr.<key>` */
  prefixes: readonly string[];
}

export interface ParsedRow {
  rowNumber: number;
  values: Record<string, string>;
}

/** Missing required columns and columns the kind does not know. */
export function headerProblems(header: readonly string[], columns: ImportColumns): string[] {
  const missing = columns.required.filter((name) => !header.includes(name));
  const unknown = header.filter(
    (name) =>
      !columns.required.includes(name) &&
      !columns.optional.includes(name) &&
      !columns.prefixes.some((prefix) => name.startsWith(prefix) && name.length > prefix.length),
  );
  return [
    ...(missing.length ? [`Missing required column(s): ${missing.join(', ')}`] : []),
    ...(unknown.length ? [`Unknown column(s): ${unknown.join(', ')}`] : []),
  ];
}

/** The error of each row whose key an earlier row already used, e.g. a SKU listed twice. */
export function duplicateKeyErrors(
  rows: readonly ParsedRow[],
  keyOf: (row: ParsedRow) => string | undefined,
  describe: (row: ParsedRow) => string,
): Map<number, string> {
  const firstRow = new Map<string, number>();
  const errors = new Map<number, string>();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === undefined) continue;
    const first = firstRow.get(key);
    if (first === undefined) firstRow.set(key, row.rowNumber);
    else errors.set(row.rowNumber, `${describe(row)} is already in row ${first}`);
  }
  return errors;
}

const AMOUNT = /^\d{1,10}(\.\d{1,2})?$/;
const WHOLE = /^[+-]?\d{1,9}$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** A non-negative amount with at most 2 decimals and a dot as the decimal separator. */
export function parseAmount(column: string, text: string): Parsed<Prisma.Decimal> {
  if (!AMOUNT.test(text)) {
    return { ok: false, error: `${column} must be an amount such as 12.50 (dot for decimals), got "${text}"` };
  }
  return { ok: true, value: new Prisma.Decimal(text) };
}

export function parseWholeNumber(column: string, text: string, { min }: { min?: number } = {}): Parsed<number> {
  if (!WHOLE.test(text)) return { ok: false, error: `${column} must be a whole number, got "${text}"` };
  const value = Number(text);
  if (min !== undefined && value < min) return { ok: false, error: `${column} must be at least ${min}, got ${value}` };
  return { ok: true, value };
}

const TRUE_WORDS = ['true', 'yes', '1'];
const FALSE_WORDS = ['false', 'no', '0'];

export function parseFlag(column: string, text: string): Parsed<boolean> {
  const word = text.toLowerCase();
  if (TRUE_WORDS.includes(word)) return { ok: true, value: true };
  if (FALSE_WORDS.includes(word)) return { ok: true, value: false };
  return { ok: false, error: `${column} must be true or false, got "${text}"` };
}

export function textProblem(column: string, text: string | undefined, maxLength: number): string | null {
  return text !== undefined && text.length > maxLength ? `${column} must be at most ${maxLength} characters` : null;
}
