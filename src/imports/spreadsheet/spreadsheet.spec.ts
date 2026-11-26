import { parse } from 'csv-parse/sync';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { ImportFileFormat } from '../../generated/prisma/client';
import { detectImportFormat, ImportFileError, MAX_IMPORT_FILE_BYTES } from './file-format';
import { detectDelimiter, MAX_IMPORT_ROWS, normaliseColumnName, readTable } from './table-reader';
import { escapeFormula, toCsv, toXlsx } from './table-writer';

const xlsx = (rows: (string | number | null)[][], sheet = 'Sheet1') =>
  writeXlsxFile(
    rows.map((row) => row.map((value) => (value === null ? null : { value }))),
    { sheet },
  ).toBuffer();

describe('detectImportFormat', () => {
  it('recognises an .xlsx workbook by its contents and UTF-8 text as CSV', async () => {
    expect(detectImportFormat(await xlsx([['sku']]))).toBe(ImportFileFormat.XLSX);
    expect(detectImportFormat(Buffer.from('sku,base_price\nA,1.00\n'))).toBe(ImportFileFormat.CSV);
  });

  it('refuses empty, oversized, macro-enabled, legacy .xls, other zip and binary files', () => {
    const zip = (name: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(name)]);
    const cases: [Buffer, RegExp][] = [
      [Buffer.alloc(0), /empty/],
      [Buffer.alloc(MAX_IMPORT_FILE_BYTES + 1, 'a'), /limit/],
      [zip('xl/workbook.xml xl/vbaProject.bin'), /Macro-enabled/],
      [zip('word/document.xml'), /not an Excel/],
      [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), /Legacy Excel/],
      [Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]), /neither/],
      [Buffer.from([0x73, 0x6b, 0x75, 0xff, 0xfe]), /not UTF-8/],
    ];
    for (const [buffer, message] of cases) {
      expect(() => detectImportFormat(buffer)).toThrow(ImportFileError);
      expect(() => detectImportFormat(buffer)).toThrow(message);
    }
  });
});

describe('readTable', () => {
  it('reads a CSV with a BOM, normalises the header and keeps sheet line numbers across blank rows', async () => {
    const table = await readTable(
      Buffer.from('﻿SKU, Base Price ,attr.Colour\nA-1,12.50,Red\n,,\nB-2,"1,000.00",\n'),
      ImportFileFormat.CSV,
      null,
    );

    expect(table.header).toEqual(['sku', 'base_price', 'attr.colour']);
    expect(table.rows).toEqual([
      { rowNumber: 2, values: { sku: 'A-1', base_price: '12.50', 'attr.colour': 'Red' }, extraCells: 0 },
      { rowNumber: 4, values: { sku: 'B-2', base_price: '1,000.00' }, extraCells: 0 },
    ]);
  });

  it('accepts semicolon-separated CSV and counts values beyond the header', async () => {
    const table = await readTable(Buffer.from('sku;count\nA;3;extra\n'), ImportFileFormat.CSV, null);

    expect(table.rows).toEqual([{ rowNumber: 2, values: { sku: 'A', count: '3' }, extraCells: 1 }]);
  });

  it('reads the first sheet or a named one, keeping numbers as text', async () => {
    const workbook = await writeXlsxFile([
      { sheet: 'Notes', data: [[{ value: 'ignore me' }]] },
      {
        sheet: 'Prices',
        data: [
          [{ value: 'sku' }, { value: 'base_price' }],
          [{ value: 'A-1' }, { value: 12.5 }],
        ],
      },
    ]).toBuffer();

    const named = await readTable(workbook, ImportFileFormat.XLSX, 'prices');
    const first = await readTable(workbook, ImportFileFormat.XLSX, null);

    expect(named.rows).toEqual([{ rowNumber: 2, values: { sku: 'A-1', base_price: '12.5' }, extraCells: 0 }]);
    expect(first.header).toEqual(['ignore_me']);
    await expect(readTable(workbook, ImportFileFormat.XLSX, 'Stock')).rejects.toThrow('no sheet "Stock"');
  });

  it('refuses a missing header, blank or repeated column names, too many rows and unreadable CSV', async () => {
    const csv = (text: string) => readTable(Buffer.from(text), ImportFileFormat.CSV, null);

    await expect(csv('\n')).rejects.toThrow('no header row');
    await expect(csv('sku,,count\n')).rejects.toThrow('Column 2 has no name');
    await expect(csv('sku,SKU\n')).rejects.toThrow('"sku" appears more than once');
    await expect(csv('sku,"open\nA,1\n')).rejects.toThrow('cannot be read');
    await expect(csv(`sku\n${'A\n'.repeat(MAX_IMPORT_ROWS + 1)}`)).rejects.toThrow('the limit is 10000');
  });

  it('helpers: column names and delimiter detection', () => {
    expect(normaliseColumnName('  Low  Stock Threshold ')).toBe('low_stock_threshold');
    expect(detectDelimiter('sku;base_price;reason\nA;1,5;x')).toBe(';');
    expect(detectDelimiter('sku,note\nA,"a;b;c"')).toBe(',');
  });
});

describe('formula escaping', () => {
  it('prefixes text that a spreadsheet would run, but not plain numbers', () => {
    expect(escapeFormula('=HYPERLINK("http://evil")')).toBe('\'=HYPERLINK("http://evil")');
    expect(escapeFormula('+1+1')).toBe("'+1+1");
    expect(escapeFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(escapeFormula('-2+3')).toBe("'-2+3");
    expect(escapeFormula('\tcmd')).toBe("'\tcmd");
    expect(escapeFormula('-3')).toBe('-3');
    expect(escapeFormula('12.50')).toBe('12.50');
    expect(escapeFormula('Plain text')).toBe('Plain text');
  });

  it('escapes CSV and XLSX output cells', async () => {
    const csv = toCsv(['name', 'qty', 'guest', 'taxable'], [['=1+2', -3, true, false]]).toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(parse(csv.slice(1))).toEqual([
      ['name', 'qty', 'guest', 'taxable'],
      ["'=1+2", '-3', 'true', 'false'],
    ]);

    const [sheet] = await readXlsxFile(await toXlsx(['name'], [['@cmd'], [null]], 'Report'));
    expect(sheet.sheet).toBe('Report');
    expect(sheet.data[1]).toEqual(["'@cmd"]);
  });
});
