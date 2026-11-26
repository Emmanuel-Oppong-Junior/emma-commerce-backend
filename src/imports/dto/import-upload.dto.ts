import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { SpreadsheetFormat } from '../spreadsheet/table-writer';

/** Multipart text fields sent with an import file. */
export class ImportUploadDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sheet?: string;

  /** "true": apply the valid rows as soon as validation ends; otherwise a dry run waiting for apply. */
  @IsOptional()
  @IsIn(['true', 'false'])
  apply?: 'true' | 'false';
}

export class SpreadsheetFormatQuery {
  @IsOptional()
  @IsIn(['csv', 'xlsx'])
  format?: SpreadsheetFormat;
}
