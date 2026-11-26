import { parse } from 'csv-parse/sync';
import readXlsxFile from 'read-excel-file/node';
import { ImportFileFormat } from '../../generated/prisma/client';
import { ImportFileError } from './file-format';

export const MAX_IMPORT_ROWS = 10_000;
export const MAX_IMPORT_COLUMNS = 100;

export interface TableRow {
  /** Line of the row in the sheet, the header being line 1 */
  rowNumber: number;
  /** Non-blank cells by normalised column name */
  values: Record<string, string>;
  /** Cells beyond the last named column that hold something */
  extraCells: number;
}

export interface Table {
  header: string[];
  rows: TableRow[];
}

/** "Base Price " → "base_price"; "attr.Colour" → "attr.colour". */
export function normaliseColumnName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, '_');
}

/** Semicolon when the header line has more semicolons than commas (Excel's CSV in decimal-comma locales). */
export function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (char: string) => firstLine.split(char).length - 1;
  return count(';') > count(',') ? ';' : ',';
}

function parseCsv(buffer: Buffer): string[][] {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  try {
    return parse(text, { delimiter: detectDelimiter(text), relax_column_count: true, trim: true }) as string[][];
  } catch (error) {
    throw new ImportFileError(`The CSV file cannot be read: ${(error as Error).message}`);
  }
}

function cellText(cell: string | number | boolean | Date | null): string {
  if (cell === null) return '';
  if (cell instanceof Date) {
    const iso = cell.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  return String(cell).trim();
}

async function parseXlsx(buffer: Buffer, sheetName: string | null): Promise<string[][]> {
  let sheets: { sheet: string; data: (string | number | boolean | Date | null)[][] }[];
  try {
    // Numbers stay text, so prices are never rounded through floating point.
    sheets = await readXlsxFile<string>(buffer, { parseNumber: (text) => text });
  } catch (error) {
    throw new ImportFileError(`The Excel file cannot be read: ${(error as Error).message}`);
  }
  const sheet = sheetName
    ? sheets.find((candidate) => candidate.sheet.toLowerCase() === sheetName.toLowerCase())
    : sheets[0];
  if (!sheet) {
    throw new ImportFileError(
      `The workbook has no sheet "${sheetName}"; its sheets are ${sheets.map((s) => `"${s.sheet}"`).join(', ')}`,
    );
  }
  return sheet.data.map((row) => row.map(cellText));
}

/**
 * The header and data rows of a CSV file or of one sheet of a workbook (the first unless `sheetName` is given). Blank
 * rows are left out but keep their line numbers.
 * @throws ImportFileError for an unreadable file, no header, blank or repeated column names, or too many rows or
 *   columns.
 */
export async function readTable(buffer: Buffer, format: ImportFileFormat, sheetName: string | null): Promise<Table> {
  const lines = format === ImportFileFormat.CSV ? parseCsv(buffer) : await parseXlsx(buffer, sheetName);
  const headerCells = lines[0] ?? [];
  while (headerCells.length > 0 && headerCells[headerCells.length - 1].trim() === '') headerCells.pop();
  if (headerCells.length === 0) throw new ImportFileError('The file has no header row');
  if (headerCells.length > MAX_IMPORT_COLUMNS) {
    throw new ImportFileError(`The file has ${headerCells.length} columns; the limit is ${MAX_IMPORT_COLUMNS}`);
  }
  const header = headerCells.map(normaliseColumnName);
  const blank = header.findIndex((name) => name === '');
  if (blank >= 0) throw new ImportFileError(`Column ${blank + 1} has no name in the header row`);
  const repeated = header.find((name, index) => header.indexOf(name) !== index);
  if (repeated) throw new ImportFileError(`Column "${repeated}" appears more than once in the header row`);

  const rows: TableRow[] = [];
  lines.slice(1).forEach((cells, index) => {
    if (cells.every((cell) => cell.trim() === '')) return;
    const values: Record<string, string> = {};
    header.forEach((name, column) => {
      const cell = (cells[column] ?? '').trim();
      if (cell !== '') values[name] = cell;
    });
    const extraCells = cells.slice(header.length).filter((cell) => cell.trim() !== '').length;
    rows.push({ rowNumber: index + 2, values, extraCells });
  });
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new ImportFileError(`The file has ${rows.length} data rows; the limit is ${MAX_IMPORT_ROWS}`);
  }
  return { header, rows };
}
