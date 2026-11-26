import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { SpreadsheetFormat, toSpreadsheet } from '../imports/spreadsheet/table-writer';
import { ExportTable, orderExportTable, productExportTable, stockExportTable } from './export-rows';

/** Exports are built in one request; a larger set must be narrowed (for orders, a shorter date range). */
export const MAX_EXPORT_ROWS = 50_000;
export const MAX_ORDER_EXPORT_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface OrderExportRange {
  from: Date;
  to: Date;
}

/**
 * CSV/XLSX exports (P8-I), generated synchronously and streamed back: products with their variants, prices,
 * attributes and stock per location; stock levels; orders in a date range (guest orders included), with customer
 * details only on request. Cells that would run as formulas are escaped. Every export is audited.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async products(format: SpreadsheetFormat, actorId: string): Promise<Buffer> {
    this.assertWithinLimit(await this.prisma.variant.count(), 'variants');
    const [variants, locations] = await Promise.all([
      this.prisma.variant.findMany({
        orderBy: [{ productId: 'asc' }, { sku: 'asc' }],
        include: {
          stockLevels: { select: { locationId: true, onHand: true } },
          product: {
            include: {
              productType: { select: { key: true } },
              category: { select: { name: true } },
              subcategory: { select: { name: true } },
              brand: { select: { name: true } },
              tags: { select: { name: true }, orderBy: { name: 'asc' } },
            },
          },
        },
      }),
      this.locations(),
    ]);
    const table = productExportTable(
      variants.map((variant) => ({
        ...variant,
        onHand: new Map(variant.stockLevels.map((level) => [level.locationId, level.onHand])),
        product: {
          id: variant.product.id,
          name: variant.product.name,
          status: variant.product.status,
          isTaxable: variant.product.isTaxable,
          attributes: variant.product.attributes,
          productType: variant.product.productType.key,
          category: variant.product.category?.name ?? null,
          subcategory: variant.product.subcategory?.name ?? null,
          brand: variant.product.brand?.name ?? null,
          tags: variant.product.tags.map((tag) => tag.name),
        },
      })),
      locations,
    );
    return this.finish('products', table, format, actorId, {});
  }

  async stock(format: SpreadsheetFormat, actorId: string): Promise<Buffer> {
    this.assertWithinLimit(await this.prisma.stockLevel.count(), 'stock levels');
    const levels = await this.prisma.stockLevel.findMany({
      orderBy: [{ variant: { sku: 'asc' } }, { location: { name: 'asc' } }],
      select: {
        onHand: true,
        reserved: true,
        variant: { select: { sku: true, product: { select: { name: true } } } },
        location: { select: { name: true } },
      },
    });
    const table = stockExportTable(
      levels.map((level) => ({
        sku: level.variant.sku,
        productName: level.variant.product.name,
        locationName: level.location.name,
        onHand: level.onHand,
        reserved: level.reserved,
      })),
    );
    return this.finish('stock', table, format, actorId, {});
  }

  /** @throws BadRequestException for an empty, reversed or too long range, or too many orders in it. */
  async orders(
    range: OrderExportRange,
    withCustomers: boolean,
    format: SpreadsheetFormat,
    actorId: string,
  ): Promise<Buffer> {
    if (!(range.from < range.to)) throw new BadRequestException('from must be before to');
    if (range.to.getTime() - range.from.getTime() > MAX_ORDER_EXPORT_DAYS * DAY_MS) {
      throw new BadRequestException(`The range must be at most ${MAX_ORDER_EXPORT_DAYS} days`);
    }
    const where = { deleted: false, createdAt: { gte: range.from, lt: range.to } };
    this.assertWithinLimit(await this.prisma.order.count({ where }), 'orders');
    const orders = await this.prisma.order.findMany({
      where,
      orderBy: { orderNumber: 'asc' },
      include: {
        items: { select: { quantity: true } },
        paymentIntent: { select: { status: true } },
        ...(withCustomers && { user: { select: { name: true, email: true } } }),
      },
    });
    const table = orderExportTable(
      orders.map((order) => ({
        ...order,
        paymentStatus: order.paymentIntent?.status ?? null,
        isGuest: order.userId === null,
        units: order.items.reduce((sum, item) => sum + item.quantity, 0),
        customer: {
          name: order.contactName ?? order.user?.name ?? null,
          email: order.contactEmail ?? order.user?.email ?? null,
          phone: order.contactPhone,
          address: order.shippingAddressSnapshot,
        },
      })),
      withCustomers,
    );
    return this.finish('orders', table, format, actorId, {
      from: range.from.toISOString(),
      to: range.to.toISOString(),
      customerDetails: withCustomers,
    });
  }

  private locations() {
    return this.prisma.stockLocation.findMany({
      where: { store: { singleton: true } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private assertWithinLimit(count: number, what: string): void {
    if (count > MAX_EXPORT_ROWS) {
      throw new BadRequestException(`There are ${count} ${what}; an export holds at most ${MAX_EXPORT_ROWS}`);
    }
  }

  private async finish(
    kind: string,
    table: ExportTable,
    format: SpreadsheetFormat,
    actorId: string,
    details: Record<string, string | boolean>,
  ): Promise<Buffer> {
    const file = await toSpreadsheet(format, table.header, table.rows, kind);
    await this.auditService.log({
      entity: 'Export',
      entityId: kind,
      action: 'EXPORT',
      userId: actorId,
      details: { format, rows: table.rows.length, ...details },
    });
    return file;
  }
}
