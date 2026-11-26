import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ImportKind } from '../generated/prisma/client';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { MAX_IMPORT_FILE_BYTES } from './spreadsheet/file-format';
import { spreadsheetDownload } from './spreadsheet/download';
import { ImportUploadDto, SpreadsheetFormatQuery } from './dto/import-upload.dto';
import { CATALOG_IMPORT_KINDS, ImportsService, STOCK_IMPORT_KINDS } from './imports.service';
import { ImportJobRecord } from './import-queue';

// A larger file is refused by multer with 413 before it is buffered in full.
const multerOptions = { storage: memoryStorage(), limits: { fileSize: MAX_IMPORT_FILE_BYTES, files: 1 } };
const UPLOAD_THROTTLE = { upload: { limit: 10, ttl: 60000 } };

/**
 * Bulk import files (P8-I): multipart upload (field "file", optional "sheet" and "apply"), the template of each kind
 * and the per-row report. Jobs are read, applied and cancelled through GraphQL.
 */
@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  @RequirePermission('catalog.import')
  @Throttle(UPLOAD_THROTTLE)
  @Post('products')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  uploadProducts(
    @ActiveUser('id') actorId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: ImportUploadDto,
  ): Promise<ImportJobRecord> {
    return this.upload(ImportKind.PRODUCTS, file, body, actorId);
  }

  @RequirePermission('catalog.import')
  @RequireStepUp()
  @Throttle(UPLOAD_THROTTLE)
  @Post('prices')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  uploadPrices(
    @ActiveUser('id') actorId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: ImportUploadDto,
  ): Promise<ImportJobRecord> {
    return this.upload(ImportKind.PRICES, file, body, actorId);
  }

  @RequirePermission('inventory.import')
  @Throttle(UPLOAD_THROTTLE)
  @Post('stock')
  @UseInterceptors(FileInterceptor('file', multerOptions))
  uploadStock(
    @ActiveUser('id') actorId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: ImportUploadDto,
  ): Promise<ImportJobRecord> {
    return this.upload(ImportKind.STOCK, file, body, actorId);
  }

  @RequirePermission('catalog.import')
  @Get('products/template')
  async productsTemplate(@Query() { format = 'csv' }: SpreadsheetFormatQuery): Promise<StreamableFile> {
    return spreadsheetDownload(
      await this.importsService.template(ImportKind.PRODUCTS, format),
      format,
      'products-import',
    );
  }

  @RequirePermission('catalog.import')
  @Get('prices/template')
  async pricesTemplate(@Query() { format = 'csv' }: SpreadsheetFormatQuery): Promise<StreamableFile> {
    return spreadsheetDownload(await this.importsService.template(ImportKind.PRICES, format), format, 'prices-import');
  }

  @RequirePermission('inventory.import')
  @Get('stock/template')
  async stockTemplate(@Query() { format = 'csv' }: SpreadsheetFormatQuery): Promise<StreamableFile> {
    return spreadsheetDownload(await this.importsService.template(ImportKind.STOCK, format), format, 'stock-import');
  }

  @RequirePermission('catalog.import')
  @Get('catalog/:id/report')
  async catalogReport(
    @Param('id') id: string,
    @Query() { format = 'csv' }: SpreadsheetFormatQuery,
  ): Promise<StreamableFile> {
    const report = await this.importsService.report(id, CATALOG_IMPORT_KINDS, format);
    return spreadsheetDownload(report, format, `import-${id}-report`);
  }

  @RequirePermission('inventory.import')
  @Get('stock/:id/report')
  async stockReport(
    @Param('id') id: string,
    @Query() { format = 'csv' }: SpreadsheetFormatQuery,
  ): Promise<StreamableFile> {
    const report = await this.importsService.report(id, STOCK_IMPORT_KINDS, format);
    return spreadsheetDownload(report, format, `import-${id}-report`);
  }

  private upload(
    kind: ImportKind,
    file: Express.Multer.File | undefined,
    body: ImportUploadDto,
    actorId: string,
  ): Promise<ImportJobRecord> {
    return this.importsService.upload(kind, file, { sheet: body.sheet, apply: body.apply === 'true' }, actorId);
  }
}
