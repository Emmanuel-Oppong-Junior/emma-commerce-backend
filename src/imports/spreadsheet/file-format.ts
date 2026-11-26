import { ImportFileFormat } from '../../generated/prisma/client';

export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024;

/** A file that cannot be imported at all; its message is shown to staff as the job's error. */
export class ImportFileError extends Error {}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);

/**
 * What the bytes are, never trusting the file name: an .xlsx workbook (a zip holding xl/workbook.xml, without VBA
 * macros) or UTF-8 text taken as CSV. Zip entry names are stored uncompressed, so they can be searched directly.
 * @throws ImportFileError for an empty, macro-enabled, legacy binary or otherwise unsupported file.
 */
export function detectImportFormat(buffer: Buffer): ImportFileFormat {
  if (buffer.length === 0) throw new ImportFileError('The file is empty');
  if (buffer.length > MAX_IMPORT_FILE_BYTES) {
    throw new ImportFileError(`The file is ${buffer.length} bytes; the limit is ${MAX_IMPORT_FILE_BYTES}`);
  }
  if (buffer.subarray(0, 4).equals(ZIP_MAGIC)) {
    if (buffer.includes('vbaProject.bin') || buffer.includes('macroEnabled')) {
      throw new ImportFileError('Macro-enabled workbooks are refused: save the sheet as .xlsx or CSV');
    }
    if (buffer.includes('xl/workbook.xml')) return ImportFileFormat.XLSX;
    throw new ImportFileError('The file is a zip archive but not an Excel .xlsx workbook');
  }
  if (buffer.subarray(0, 4).equals(OLE_MAGIC)) {
    throw new ImportFileError('Legacy Excel .xls files are not supported: save the sheet as .xlsx or CSV');
  }
  if (buffer.includes(0)) throw new ImportFileError('The file is neither a UTF-8 CSV nor an Excel .xlsx workbook');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new ImportFileError('The CSV file is not UTF-8 text: save it as "CSV UTF-8"');
  }
  return ImportFileFormat.CSV;
}
