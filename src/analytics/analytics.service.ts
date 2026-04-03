import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SalesReport } from './entities/sales-report.entity';
import { TopProduct } from './entities/top-product.entity';
import { RevenueByCategoryEntity } from './entities/revenue-by-category.entity';
import { DashboardSummary } from './entities/dashboard-summary.entity';

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns aggregated sales figures (revenue, order count, average order value) for the given date range.
   * @param startDate - Start of the reporting period (inclusive).
   * @param endDate - End of the reporting period (inclusive).
   * @returns Aggregated sales report.
   */
  async getSalesReport(startDate: Date, endDate: Date): Promise<SalesReport> {
    const result = await this.prisma.order.aggregate({
      where: {
        status: { not: 'CANCELLED' },
        deleted: false,
        createdAt: { gte: startDate, lte: endDate },
      },
      _sum: { totalAmount: true },
      _count: { id: true },
      _avg: { totalAmount: true },
    });

    return {
      totalRevenue: Number(result._sum.totalAmount ?? 0),
      orderCount: result._count.id,
      averageOrderValue: Number(result._avg.totalAmount ?? 0),
    };
  }

  /**
   * Returns the top-selling products ranked by total quantity sold.
   * @param limit - Maximum number of products to return.
   * @returns List of top products with quantity sold and revenue.
   */
  async getTopProducts(limit: number): Promise<TopProduct[]> {
    type RawRow = { productId: string; productName: string; totalQuantitySold: bigint; totalRevenue: number };
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT
        oi."productId",
        p.name AS "productName",
        SUM(oi.quantity)::bigint AS "totalQuantitySold",
        SUM(oi."priceAtOrder" * oi.quantity) AS "totalRevenue"
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."deleted" = false AND o.status != 'CANCELLED'
      GROUP BY oi."productId", p.name
      ORDER BY "totalQuantitySold" DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => ({
      productId: r.productId,
      productName: r.productName,
      totalQuantitySold: Number(r.totalQuantitySold),
      totalRevenue: Number(r.totalRevenue),
    }));
  }

  /**
   * Returns total revenue and order count grouped by product category.
   * @returns List of category revenue breakdowns, ordered by revenue descending.
   */
  async getRevenueByCategory(): Promise<RevenueByCategoryEntity[]> {
    type RawRow = { categoryId: string | null; categoryName: string | null; totalRevenue: number; orderCount: bigint };
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT
        p."categoryId",
        c.name AS "categoryName",
        SUM(oi."priceAtOrder" * oi.quantity) AS "totalRevenue",
        COUNT(DISTINCT o.id)::bigint AS "orderCount"
      FROM "OrderItem" oi
      JOIN "Product" p ON p.id = oi."productId"
      LEFT JOIN "Category" c ON c.id = p."categoryId"
      JOIN "Order" o ON o.id = oi."orderId"
      WHERE o."deleted" = false AND o.status != 'CANCELLED'
      GROUP BY p."categoryId", c.name
      ORDER BY "totalRevenue" DESC
    `;

    return rows.map((r) => ({
      categoryId: r.categoryId ?? undefined,
      categoryName: r.categoryName ?? undefined,
      totalRevenue: Number(r.totalRevenue),
      orderCount: Number(r.orderCount),
    }));
  }

  /**
   * Returns a real-time snapshot of key business metrics for the admin dashboard.
   * Includes today's orders and revenue, active user count, and low-stock counts.
   * @returns Dashboard summary with aggregated KPIs.
   */
  async getDashboardSummary(): Promise<DashboardSummary> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalUsers, ordersToday, revenueToday, lowStockProducts, lowStockVariants] = await Promise.all([
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.order.count({
        where: { deleted: false, createdAt: { gte: todayStart } },
      }),
      this.prisma.order.aggregate({
        where: {
          deleted: false,
          status: { not: 'CANCELLED' },
          createdAt: { gte: todayStart },
        },
        _sum: { totalAmount: true },
      }),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count FROM "Product"
        WHERE "isActive" = true AND quantity <= COALESCE("lowStockAlert", 5)
      `.then((r) => Number(r[0].count)),
      this.prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*)::bigint AS count FROM "Variant"
        WHERE quantity <= COALESCE("lowStockThreshold", 5)
      `.then((r) => Number(r[0].count)),
    ]);

    return {
      totalUsers,
      ordersToday,
      revenueToday: Number(revenueToday._sum.totalAmount ?? 0),
      lowStockProductCount: lowStockProducts as unknown as number,
      lowStockVariantCount: lowStockVariants as unknown as number,
    };
  }
}
