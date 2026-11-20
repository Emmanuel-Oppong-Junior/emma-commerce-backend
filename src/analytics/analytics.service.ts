import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesReport } from './entities/sales-report.entity';
import { TopProduct } from './entities/top-product.entity';
import { RevenueByCategoryEntity } from './entities/revenue-by-category.entity';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../inventory/stock';

/**
 * A payment accepted for its order: a settled online attempt or a recorded cash collection (which also writes a
 * COMPLETED cash-on-delivery attempt). Captured payments held for review are excluded; they are queued for refund.
 */
// A variant's available stock over all locations; 0 when it has no stock level yet.
const AVAILABLE_STOCK = Prisma.sql`COALESCE((SELECT sum(sl."onHand" - sl."reserved") FROM "StockLevel" sl WHERE sl."variantId" = v.id), 0)`;
const ACCEPTED_ATTEMPT = Prisma.sql`pa.status = 'COMPLETED' AND pa."reviewReason" IS NULL AND pa.deleted = false`;

// An attempt has no settled-at column: updatedAt is written by the settling update and only touched again by an
// admin soft delete or restore. Cash is recognised when it was collected.
const ACCEPTED_PAYMENTS = Prisma.sql`
  SELECT intent."orderId", pa.amount, COALESCE(cc."collectedAt", pa."updatedAt") AS "recognisedAt"
  FROM "PaymentAttempt" pa
  JOIN "PaymentIntent" intent ON intent.id = pa."intentId"
  LEFT JOIN "CashCollection" cc ON cc."attemptId" = pa.id
  WHERE ${ACCEPTED_ATTEMPT}
`;

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Revenue recognised in [startDate, endDate]: payments accepted in the period (gross) minus refunds processed in
   * the period against accepted payments. Order count and average order value cover the orders paid in the period.
   */
  async getSalesReport(startDate: Date, endDate: Date): Promise<SalesReport> {
    type RawRow = {
      grossRevenue: Prisma.Decimal;
      refunds: Prisma.Decimal;
      netRevenue: Prisma.Decimal;
      itemSales: Prisma.Decimal;
      orderCount: number;
      averageOrderValue: Prisma.Decimal;
    };
    const [row] = await this.prisma.$queryRaw<RawRow[]>`
      WITH period AS (
        SELECT * FROM (${ACCEPTED_PAYMENTS}) accepted
        WHERE "recognisedAt" >= ${startDate} AND "recognisedAt" <= ${endDate}
      ),
      totals AS (
        SELECT COALESCE(SUM(amount), 0) AS gross, COUNT(DISTINCT "orderId")::int AS "orderCount" FROM period
      ),
      items AS (
        SELECT COALESCE(SUM(oi."lineTotal"), 0) AS "itemSales"
        FROM "OrderItem" oi
        WHERE oi."orderId" IN (SELECT "orderId" FROM period)
      ),
      refunded AS (
        SELECT COALESCE(SUM(r.amount), 0) AS refunds
        FROM "Refund" r
        JOIN "PaymentAttempt" pa ON pa.id = r."attemptId"
        WHERE r.status = 'PROCESSED' AND ${ACCEPTED_ATTEMPT}
          AND r."updatedAt" >= ${startDate} AND r."updatedAt" <= ${endDate}
      )
      SELECT
        t.gross AS "grossRevenue",
        r.refunds,
        t.gross - r.refunds AS "netRevenue",
        i."itemSales",
        t."orderCount",
        COALESCE(ROUND(t.gross / NULLIF(t."orderCount", 0), 2), 0) AS "averageOrderValue"
      FROM totals t, items i, refunded r
    `;

    const netRevenue = new Prisma.Decimal(row.netRevenue);
    return {
      grossRevenue: new Prisma.Decimal(row.grossRevenue),
      refunds: new Prisma.Decimal(row.refunds),
      netRevenue,
      totalRevenue: netRevenue,
      itemSales: new Prisma.Decimal(row.itemSales),
      orderCount: row.orderCount,
      averageOrderValue: new Prisma.Decimal(row.averageOrderValue),
    };
  }

  /**
   * Returns the top-selling products of paid orders, ranked by quantity sold, with their item sales.
   * @param limit - Maximum number of products to return.
   */
  async getTopProducts(limit: number): Promise<TopProduct[]> {
    type RawRow = {
      productId: string;
      productName: string;
      totalQuantitySold: bigint;
      totalRevenue: Prisma.Decimal;
    };
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT
        oi."productId",
        p.name AS "productName",
        SUM(oi.quantity)::bigint AS "totalQuantitySold",
        SUM(oi."lineTotal") AS "totalRevenue"
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      WHERE oi."orderId" IN (SELECT "orderId" FROM (${ACCEPTED_PAYMENTS}) accepted)
      GROUP BY oi."productId", p.name
      ORDER BY "totalQuantitySold" DESC, oi."productId"
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      // eslint-disable-next-line no-restricted-syntax -- a unit count (SUM returns bigint), not money
      totalQuantitySold: Number(r.totalQuantitySold),
      totalRevenue: new Prisma.Decimal(r.totalRevenue),
    }));
  }

  /** Item sales and paid-order count of paid orders grouped by product category, highest sales first. */
  async getRevenueByCategory(): Promise<RevenueByCategoryEntity[]> {
    type RawRow = {
      categoryId: string | null;
      categoryName: string | null;
      totalRevenue: Prisma.Decimal;
      orderCount: bigint;
    };
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT
        p."categoryId",
        c.name AS "categoryName",
        SUM(oi."lineTotal") AS "totalRevenue",
        COUNT(DISTINCT oi."orderId")::bigint AS "orderCount"
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      LEFT JOIN "Category" c ON c.id = p."categoryId"
      WHERE oi."orderId" IN (SELECT "orderId" FROM (${ACCEPTED_PAYMENTS}) accepted)
      GROUP BY p."categoryId", c.name
      ORDER BY "totalRevenue" DESC
    `;

    return rows.map((r) => ({
      categoryId: r.categoryId ?? undefined,
      categoryName: r.categoryName ?? undefined,
      totalRevenue: new Prisma.Decimal(r.totalRevenue),
      // eslint-disable-next-line no-restricted-syntax -- an order count (COUNT returns bigint), not money
      orderCount: Number(r.orderCount),
    }));
  }

  /**
   * Returns a real-time snapshot of key business metrics for the admin dashboard. Today's orders and revenue are
   * the sales report from the start of today until now.
   */
  async getDashboardSummary(): Promise<DashboardSummary> {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [totalUsers, today, lowStockProducts, lowStockVariants] = await Promise.all([
      this.prisma.user.count({ where: { isActive: true } }),
      this.getSalesReport(todayStart, now),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(DISTINCT p.id)::bigint AS count
        FROM "Product" p JOIN "Variant" v ON v."productId" = p.id
        WHERE p."isActive" AND v."isActive"
          AND ${AVAILABLE_STOCK} <= COALESCE(v."lowStockThreshold", ${DEFAULT_LOW_STOCK_THRESHOLD})
      `
        // eslint-disable-next-line no-restricted-syntax -- a row count (COUNT returns bigint), not money
        .then((r) => Number(r[0].count)),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count
        FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
        WHERE p."isActive" AND v."isActive"
          AND ${AVAILABLE_STOCK} <= COALESCE(v."lowStockThreshold", ${DEFAULT_LOW_STOCK_THRESHOLD})
      `
        // eslint-disable-next-line no-restricted-syntax -- a row count (COUNT returns bigint), not money
        .then((r) => Number(r[0].count)),
    ]);

    return {
      totalUsers,
      ordersToday: today.orderCount,
      revenueToday: today.netRevenue,
      grossRevenueToday: today.grossRevenue,
      refundsToday: today.refunds,
      lowStockProductCount: lowStockProducts,
      lowStockVariantCount: lowStockVariants,
    };
  }
}
