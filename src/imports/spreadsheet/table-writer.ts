import { stringify } from 'csv-stringify/sync';
import writeXlsxFile from 'write-excel-file/node';

export type SpreadsheetFormat = 'csv' | 'xlsx';
export type CellValue = string | number | boolean | null;

export const SPREADSHEET_CONTENT_TYPES: Record<SpreadsheetFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Text a spreadsheet would run as a formula (starting with = + - @, tab or carriage return) gets a leading
 * apostrophe (OWASP CSV injection). A plain number such as "-3" cannot be a formula and is left as it is.
 */
export function escapeFormula(text: string): string {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

function safeCell(value: CellValue): CellValue {
  return typeof value === 'string' ? escapeFormula(value) : value;
}

/** UTF-8 CSV with a byte-order mark, so Excel opens accented names correctly. */
export function toCsv(header: string[], rows: CellValue[][]): Buffer {
  const body = stringify(
    [header, ...rows].map((row) => row.map(safeCell)),
    { cast: { boolean: (value) => String(value) } },
  );
  return Buffer.from(`﻿${body}`, 'utf8');
}

export async function toXlsx(header: string[], rows: CellValue[][], sheet: string): Promise<Buffer> {
  const data = [header, ...rows].map((row) =>
    row.map((value) => {
      const cell = safeCell(value);
      return cell === null ? null : { value: cell };
    }),
  );
  return writeXlsxFile(data, { sheet }).toBuffer();
}

export function toSpreadsheet(
  format: SpreadsheetFormat,
  header: string[],
  rows: CellValue[][],
  sheet: string,
): Promise<Buffer> {
  return format === 'csv' ? Promise.resolve(toCsv(header, rows)) : toXlsx(header, rows, sheet);
}
