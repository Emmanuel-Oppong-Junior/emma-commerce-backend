import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Decimal } from '@prisma/client/runtime/client';
import { AnalyticsDailySales, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../commons/audit.service';
import { roundHalfUp } from '../commons/money/money';
import { JobQueue } from '../jobs/job-queues';
import { DEFAULT_LOW_STOCK_THRESHOLD } from '../inventory/stock';
import { DashboardSummary } from './entities/dashboard-summary.entity';
import {
  AnalyticsRebuild,
  CategoryMargin,
  Cohort,
  ConversionReport,
  InventoryValuation,
  MarginReport,
  ProductMargin,
  PromotionPerformance,
  SalesReport,
  TopCategory,
  TopProduct,
} from './entities/reports.entities';
import { TopProductsOrder } from './dto/report.args';
import {
  DayRange,
  dayKey,
  daysIn,
  daysOf,
  groupByBucket,
  ReportBucket,
  reportRange,
  startOfUtcDay,
} from './domain/report-range';
import { DailySales, salesTotals } from './domain/sales-totals';
import { margin, MarginSums } from './domain/margins';
import { funnel } from './domain/conversion';
import {
  addMonths,
  assembleCohorts,
  CohortCell,
  CohortSize,
  MAX_COHORTS,
  monthsBetween,
  parseMonth,
} from './domain/cohorts';
import { ANALYTICS_REBUILD_JOB, RebuildJobData } from './rollup/analytics-rollup.service';

// A variant's available stock over all locations; 0 when it has no stock level yet.
const AVAILABLE_STOCK = Prisma.sql`COALESCE((SELECT sum(sl."onHand" - sl."reserved") FROM "StockLevel" sl WHERE sl."variantId" = v.id), 0)`;

const MARGIN_SUMS = Prisma.sql`
  COALESCE(sum(a."unitsSold"), 0)::int AS "unitsSold",
  COALESCE(sum(a."costedNetSales"), 0) AS "costedNetSales",
  COALESCE(sum(a.cogs), 0) AS cogs,
  COALESCE(sum(a."unknownCostUnits"), 0)::int AS "unknownCostUnits",
  COALESCE(sum(a."unknownCostNetSales"), 0) AS "unknownCostNetSales"
`;
const BY_MARGIN = Prisma.sql`sum(a."costedNetSales") - sum(a.cogs) DESC`;

const ZERO = new Decimal(0);

function zeroDay(day: Date): DailySales {
  return {
    day,
    paidOrders: 0,
    unitsSold: 0,
    grossRevenue: ZERO,
    itemSales: ZERO,
    itemDiscounts: ZERO,
    orderDiscounts: ZERO,
    loyaltyDiscounts: ZERO,
    shipping: ZERO,
    shippingDiscounts: ZERO,
    tax: ZERO,
    refundCount: 0,
    refunds: ZERO,
    refundedShipping: ZERO,
    refundedTax: ZERO,
    unallocatedRefunds: ZERO,
    ordersPlaced: 0,
    cartsStarted: 0,
    checkoutQuotes: 0,
  };
}

/**
 * Staff reports (P8-A). Sales, margins, top sellers, conversion, cohorts and promotions read the daily rollups the
 * analytics jobs build (bounded by the 731-day range); inventory valuation and the dashboard's stock counts are live.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @InjectQueue(JobQueue.MAINTENANCE) private readonly maintenance: Queue,
  ) {}

  async salesReport(firstDay: string, lastDay: string, bucket: ReportBucket): Promise<SalesReport> {
    const { days, computed } = await this.dailySales(toRange(firstDay, lastDay));
    return {
      totals: salesTotals(days),
      buckets: groupByBucket(days, bucket).map((group) => ({
        firstDay: dayKey(group.firstDay),
        lastDay: dayKey(group.lastDay),
        ...salesTotals(group.rows),
      })),
      ...freshness(computed, days.length),
    };
  }

  async conversionReport(firstDay: string, lastDay: string, bucket: ReportBucket): Promise<ConversionReport> {
    const { days, computed } = await this.dailySales(toRange(firstDay, lastDay));
    return {
      totals: funnel(days),
      buckets: groupByBucket(days, bucket).map((group) => ({
        firstDay: dayKey(group.firstDay),
        lastDay: dayKey(group.lastDay),
        ...funnel(group.rows),
      })),
      ...freshness(computed, days.length),
    };
  }

  async topProducts(
    firstDay: string,
    lastDay: string,
    first: number,
    orderBy: TopProductsOrder,
  ): Promise<TopProduct[]> {
    const { from, to } = toRange(firstDay, lastDay);
    const order =
      orderBy === TopProductsOrder.SALES
        ? Prisma.sql`sum(a.sales) DESC, sum(a."unitsSold") DESC`
        : Prisma.sql`sum(a."unitsSold") DESC, sum(a.sales) DESC`;
    const rows = await this.prisma.$queryRaw<(Omit<TopProduct, 'archived' | 'netSales'> & { status: string })[]>`
      SELECT a."productId", p.name AS "productName", p.status::text AS status,
        sum(a."unitsSold")::int AS "unitsSold", sum(a."unitsRefunded")::int AS "unitsRefunded",
        sum(a.sales) AS sales, sum(a.refunds) AS refunds
      FROM "AnalyticsDailyVariant" a JOIN "Product" p ON p.id = a."productId"
      WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
      GROUP BY a."productId", p.name, p.status
      HAVING sum(a."unitsSold") > 0
      ORDER BY ${order}, a."productId"
      LIMIT ${first}
    `;
    return rows.map(({ status, ...row }) => ({
      ...row,
      archived: status === 'ARCHIVED',
      netSales: row.sales.sub(row.refunds),
    }));
  }

  async topCategories(firstDay: string, lastDay: string, first: number): Promise<TopCategory[]> {
    const { from, to } = toRange(firstDay, lastDay);
    const rows = await this.prisma.$queryRaw<Omit<TopCategory, 'netSales'>[]>`
      SELECT p."categoryId", c.name AS "categoryName", sum(a."unitsSold")::int AS "unitsSold",
        sum(a.sales) AS sales, sum(a.refunds) AS refunds
      FROM "AnalyticsDailyVariant" a
      JOIN "Product" p ON p.id = a."productId"
      LEFT JOIN "Category" c ON c.id = p."categoryId"
      WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
      GROUP BY p."categoryId", c.name
      HAVING sum(a."unitsSold") > 0
      ORDER BY sum(a.sales) DESC, p."categoryId"
      LIMIT ${first}
    `;
    return rows.map((row) => ({ ...row, netSales: row.sales.sub(row.refunds) }));
  }

  async marginReport(firstDay: string, lastDay: string, first: number): Promise<MarginReport> {
    const { from, to } = toRange(firstDay, lastDay);
    const [[overall], products, categories, [unallocated]] = await Promise.all([
      this.prisma.$queryRaw<MarginSums[]>`
        SELECT ${MARGIN_SUMS} FROM "AnalyticsDailyVariant" a WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
      `,
      this.prisma.$queryRaw<(MarginSums & { productId: string; productName: string; status: string })[]>`
        SELECT a."productId", p.name AS "productName", p.status::text AS status, ${MARGIN_SUMS}
        FROM "AnalyticsDailyVariant" a JOIN "Product" p ON p.id = a."productId"
        WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
        GROUP BY a."productId", p.name, p.status
        ORDER BY ${BY_MARGIN}, a."productId"
        LIMIT ${first}
      `,
      this.prisma.$queryRaw<(MarginSums & { categoryId: string | null; categoryName: string | null })[]>`
        SELECT p."categoryId", c.name AS "categoryName", ${MARGIN_SUMS}
        FROM "AnalyticsDailyVariant" a
        JOIN "Product" p ON p.id = a."productId"
        LEFT JOIN "Category" c ON c.id = p."categoryId"
        WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
        GROUP BY p."categoryId", c.name
        ORDER BY ${BY_MARGIN}, p."categoryId"
        LIMIT ${first}
      `,
      this.prisma.$queryRaw<{ amount: Decimal }[]>`
        SELECT COALESCE(sum(s."unallocatedRefunds"), 0) AS amount
        FROM "AnalyticsDailySales" s WHERE s.day >= ${dayKey(from)}::date AND s.day < ${dayKey(to)}::date
      `,
    ]);
    return {
      overall: margin(overall),
      byProduct: products.map(({ productId, productName, status, ...sums }): ProductMargin => ({
        productId,
        productName,
        archived: status === 'ARCHIVED',
        ...margin(sums),
      })),
      byCategory: categories.map(({ categoryId, categoryName, ...sums }): CategoryMargin => ({
        categoryId,
        categoryName,
        ...margin(sums),
      })),
      unallocatedRefunds: unallocated.amount,
    };
  }

  async cohortReport(firstMonthText: string, lastMonthText: string, followMonths: number, now = new Date()) {
    const firstMonth = parseMonth(firstMonthText);
    const lastMonth = parseMonth(lastMonthText);
    if (!firstMonth || !lastMonth) throw new BadRequestException('Months are YYYY-MM');
    if (lastMonth < firstMonth) {
      throw new BadRequestException(`The last month ${lastMonthText} is before the first month ${firstMonthText}`);
    }
    if (monthsBetween(firstMonth, lastMonth) >= MAX_COHORTS) {
      throw new BadRequestException(`A cohort report covers at most ${MAX_COHORTS} months`);
    }
    const from = firstMonth;
    const to = addMonths(lastMonth, 1);
    const [sizes, cells] = await Promise.all([
      this.prisma.$queryRaw<CohortSize[]>`
        WITH firsts AS (${firstPaidMonths(from, to)})
        SELECT f.cohort AS month, count(*)::int AS customers,
          count(*) FILTER (WHERE f."totalOrders" >= 2)::int AS "repeatCustomers"
        FROM firsts f
        GROUP BY f.cohort
      `,
      this.prisma.$queryRaw<CohortCell[]>`
        WITH firsts AS (${firstPaidMonths(from, to)}),
        months AS (
          SELECT c."customerKey", date_trunc('month', c.day::timestamp)::date AS month,
            sum(c.orders) AS orders, sum(c.revenue - c.refunds) AS "netRevenue"
          FROM "AnalyticsDailyCustomer" c
          WHERE c."customerKey" IN (SELECT "customerKey" FROM firsts)
          GROUP BY 1, 2
        ),
        cells AS (
          SELECT f.cohort AS month,
            ((EXTRACT(YEAR FROM m.month) - EXTRACT(YEAR FROM f.cohort)) * 12
              + EXTRACT(MONTH FROM m.month) - EXTRACT(MONTH FROM f.cohort))::int AS "offset",
            m.orders, m."netRevenue"
          FROM firsts f JOIN months m ON m."customerKey" = f."customerKey"
        )
        SELECT month, "offset", count(*) FILTER (WHERE orders > 0)::int AS "activeCustomers",
          sum(orders)::int AS orders, sum("netRevenue") AS "netRevenue"
        FROM cells
        WHERE "offset" <= ${followMonths}
        GROUP BY month, "offset"
      `,
    ]);
    const cohorts = assembleCohorts(sizes, cells, {
      firstMonth,
      lastMonth,
      followMonths,
      currentMonth: parseMonth(dayKey(now).slice(0, 7))!,
    });
    return cohorts.map((cohort): Cohort => ({ ...cohort, month: dayKey(cohort.month).slice(0, 7) }));
  }

  async inventoryValuation(): Promise<InventoryValuation> {
    const [locations, [{ unknownCostVariants }]] = await Promise.all([
      this.prisma.$queryRaw<
        {
          locationId: string;
          locationName: string;
          isActive: boolean;
          units: number;
          value: Decimal;
          unknownCostUnits: number;
        }[]
      >`
        SELECT l.id AS "locationId", l.name AS "locationName", l."isActive",
          COALESCE(sum(sl."onHand"), 0)::int AS units,
          COALESCE(sum(sl."onHand" * v."costPrice") FILTER (WHERE v."costPrice" IS NOT NULL), 0) AS value,
          COALESCE(sum(sl."onHand") FILTER (WHERE v."costPrice" IS NULL), 0)::int AS "unknownCostUnits"
        FROM "StockLocation" l
        LEFT JOIN "StockLevel" sl ON sl."locationId" = l.id AND sl."onHand" > 0
        LEFT JOIN "Variant" v ON v.id = sl."variantId"
        GROUP BY l.id, l.name, l."isActive", l."isDefault"
        ORDER BY l."isDefault" DESC, l.name, l.id
      `,
      this.prisma.$queryRaw<{ unknownCostVariants: number }[]>`
        SELECT count(DISTINCT sl."variantId")::int AS "unknownCostVariants"
        FROM "StockLevel" sl JOIN "Variant" v ON v.id = sl."variantId"
        WHERE sl."onHand" > 0 AND v."costPrice" IS NULL
      `,
    ]);
    return {
      units: locations.reduce((sum, location) => sum + location.units, 0),
      value: roundHalfUp(locations.reduce((sum, location) => sum.add(location.value), ZERO)),
      unknownCostUnits: locations.reduce((sum, location) => sum + location.unknownCostUnits, 0),
      unknownCostVariants,
      locations: locations.map((location) => ({ ...location, value: roundHalfUp(location.value) })),
    };
  }

  async promotionPerformance(firstDay: string, lastDay: string, first: number): Promise<PromotionPerformance[]> {
    const { from, to } = toRange(firstDay, lastDay);
    const rows = await this.prisma.$queryRaw<PromotionPerformance[]>`
      SELECT a."promotionId", p.name AS "promotionName", NULLIF(a."couponCode", '') AS "couponCode",
        sum(a.orders)::int AS orders, sum(a.discount) AS discount, sum(a.revenue) AS revenue, sum(a.units)::int AS units
      FROM "AnalyticsDailyPromotion" a LEFT JOIN "Promotion" p ON p.id = a."promotionId"
      WHERE a.day >= ${dayKey(from)}::date AND a.day < ${dayKey(to)}::date
      GROUP BY a."promotionId", p.name, a."couponCode"
      ORDER BY sum(a.discount) DESC, a."promotionId", a."couponCode"
      LIMIT ${first}
    `;
    return rows;
  }

  /** Today's sales from the rollup (refreshed every 15 minutes) and the live low-stock counts. */
  async dashboardSummary(now = new Date()): Promise<DashboardSummary> {
    const today = startOfUtcDay(now);
    const [totalUsers, todayRow, lowStockProducts, lowStockVariants] = await Promise.all([
      this.prisma.user.count({ where: { isActive: true } }),
      this.prisma.analyticsDailySales.findUnique({ where: { day: today } }),
      this.prisma.$queryRaw<[{ count: number }]>`
        SELECT COUNT(DISTINCT p.id)::int AS count
        FROM "Product" p JOIN "Variant" v ON v."productId" = p.id
        WHERE p."isActive" AND v."isActive"
          AND ${AVAILABLE_STOCK} <= COALESCE(v."lowStockThreshold", ${DEFAULT_LOW_STOCK_THRESHOLD})
      `.then((rows) => rows[0].count),
      this.prisma.$queryRaw<[{ count: number }]>`
        SELECT COUNT(*)::int AS count
        FROM "Variant" v JOIN "Product" p ON p.id = v."productId"
        WHERE p."isActive" AND v."isActive"
          AND ${AVAILABLE_STOCK} <= COALESCE(v."lowStockThreshold", ${DEFAULT_LOW_STOCK_THRESHOLD})
      `.then((rows) => rows[0].count),
    ]);
    const sales = salesTotals([todayRow ?? zeroDay(today)]);
    return {
      totalUsers,
      ordersToday: sales.paidOrders,
      revenueToday: sales.netRevenue,
      grossRevenueToday: sales.grossRevenue,
      refundsToday: sales.refunds,
      lowStockProductCount: lowStockProducts,
      lowStockVariantCount: lowStockVariants,
    };
  }

  /** Queues a rebuild of the days on the maintenance queue (the worker runs it) and audits who asked. */
  async requestRebuild(firstDay: string, lastDay: string, actorId: string): Promise<AnalyticsRebuild> {
    const range = toRange(firstDay, lastDay);
    const data: RebuildJobData = { from: dayKey(range.from), to: dayKey(range.to) };
    const job = await this.maintenance.add(ANALYTICS_REBUILD_JOB, data);
    await this.auditService.log({
      entity: 'AnalyticsRollup',
      entityId: String(job.id),
      action: 'CREATE',
      userId: actorId,
      details: { firstDay, lastDay, days: daysIn(range) },
    });
    return { jobId: String(job.id), firstDay, lastDay };
  }

  /** Every day of the range, a day not computed yet as zeros, and how many were computed. */
  private async dailySales(range: DayRange): Promise<{ days: DailySales[]; computed: AnalyticsDailySales[] }> {
    const computed = await this.prisma.analyticsDailySales.findMany({
      where: { day: { gte: range.from, lt: range.to } },
      orderBy: { day: 'asc' },
    });
    const byDay = new Map(computed.map((row) => [row.day.getTime(), row]));
    return { days: daysOf(range).map((day) => byDay.get(day.getTime()) ?? zeroDay(day)), computed };
  }
}

function toRange(firstDay: string, lastDay: string): DayRange {
  const result = reportRange(firstDay, lastDay);
  if ('problem' in result) throw new BadRequestException(result.problem);
  return result.range;
}

function freshness(
  computed: AnalyticsDailySales[],
  days: number,
): { refreshedAt: Date | null; daysNotComputed: number } {
  const refreshedAt = computed.reduce<Date | null>(
    (oldest, row) => (oldest === null || row.computedAt < oldest ? row.computedAt : oldest),
    null,
  );
  return { refreshedAt, daysNotComputed: days - computed.length };
}

/** Customers whose first paid order fell in [from, to), with that month and their paid orders since. */
function firstPaidMonths(from: Date, to: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT c."customerKey", date_trunc('month', (MIN(c.day) FILTER (WHERE c.orders > 0))::timestamp)::date AS cohort,
      sum(c.orders) AS "totalOrders"
    FROM "AnalyticsDailyCustomer" c
    GROUP BY c."customerKey"
    HAVING MIN(c.day) FILTER (WHERE c.orders > 0) >= ${dayKey(from)}::date
      AND MIN(c.day) FILTER (WHERE c.orders > 0) < ${dayKey(to)}::date
  `;
}
