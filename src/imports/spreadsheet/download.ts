import { StreamableFile } from '@nestjs/common';
import { SPREADSHEET_CONTENT_TYPES, SpreadsheetFormat } from './table-writer';

/** A spreadsheet download as an attachment named `<baseName>.<format>`. */
export function spreadsheetDownload(buffer: Buffer, format: SpreadsheetFormat, baseName: string): StreamableFile {
  const fileName = `${baseName.replace(/[^A-Za-z0-9._-]/g, '_')}.${format}`;
  return new StreamableFile(buffer, {
    type: SPREADSHEET_CONTENT_TYPES[format],
    disposition: `attachment; filename="${fileName}"`,
    length: buffer.length,
  });
}
