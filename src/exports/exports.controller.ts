import { Controller, Get, Query, StreamableFile } from '@nestjs/common';
import { IsDateString } from 'class-validator';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { RequirePermission, RequireStepUp } from '../iam/authorization/policy.decorators';
import { SpreadsheetFormatQuery } from '../imports/dto/import-upload.dto';
import { spreadsheetDownload } from '../imports/spreadsheet/download';
import { ExportsService } from './exports.service';

export class OrderExportQuery extends SpreadsheetFormatQuery {
  /** Inclusive start, ISO 8601 */
  @IsDateString()
  from: string;

  /** Exclusive end, ISO 8601 */
  @IsDateString()
  to: string;
}

/**
 * CSV/XLSX downloads (P8-I), `?format=csv` (default) or `xlsx`. The order export with customer names, emails, phones
 * and addresses is its own route: customer.data.export and step-up, like the other bulk customer-data export.
 */
@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @RequirePermission('catalog.export')
  @Get('products')
  async products(
    @ActiveUser('id') actorId: string,
    @Query() { format = 'csv' }: SpreadsheetFormatQuery,
  ): Promise<StreamableFile> {
    return spreadsheetDownload(await this.exportsService.products(format, actorId), format, 'products');
  }

  @RequirePermission('catalog.export')
  @Get('stock')
  async stock(
    @ActiveUser('id') actorId: string,
    @Query() { format = 'csv' }: SpreadsheetFormatQuery,
  ): Promise<StreamableFile> {
    return spreadsheetDownload(await this.exportsService.stock(format, actorId), format, 'stock-levels');
  }

  @RequirePermission('order.view')
  @Get('orders')
  async orders(@ActiveUser('id') actorId: string, @Query() query: OrderExportQuery): Promise<StreamableFile> {
    return this.orderExport(actorId, query, false);
  }

  @RequirePermission('order.view', 'customer.data.export')
  @RequireStepUp()
  @Get('orders/with-customers')
  async ordersWithCustomers(
    @ActiveUser('id') actorId: string,
    @Query() query: OrderExportQuery,
  ): Promise<StreamableFile> {
    return this.orderExport(actorId, query, true);
  }

  private async orderExport(actorId: string, query: OrderExportQuery, withCustomers: boolean): Promise<StreamableFile> {
    const format = query.format ?? 'csv';
    const range = { from: new Date(query.from), to: new Date(query.to) };
    const file = await this.exportsService.orders(range, withCustomers, format, actorId);
    return spreadsheetDownload(file, format, withCustomers ? 'orders-with-customers' : 'orders');
  }
}
