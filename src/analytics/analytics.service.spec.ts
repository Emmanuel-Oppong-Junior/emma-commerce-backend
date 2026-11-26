import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AnalyticsService } from './analytics.service';
import { ReportBucket } from './domain/report-range';
import { ANALYTICS_REBUILD_JOB } from './rollup/analytics-rollup.service';

const d = (value: string) => new Prisma.Decimal(value);

function salesRow(day: string, values: Record<string, unknown> = {}) {
  const zero = d('0');
  return {
    day: new Date(`${day}T00:00:00Z`),
    paidOrders: 0,
    unitsSold: 0,
    grossRevenue: zero,
    itemSales: zero,
    itemDiscounts: zero,
    orderDiscounts: zero,
    loyaltyDiscounts: zero,
    shipping: zero,
    shippingDiscounts: zero,
    tax: zero,
    refundCount: 0,
    refunds: zero,
    refundedShipping: zero,
    refundedTax: zero,
    unallocatedRefunds: zero,
    ordersPlaced: 0,
    cartsStarted: 0,
    checkoutQuotes: 0,
    computedAt: new Date('2026-03-04T10:00:00Z'),
    ...values,
  };
}

describe('AnalyticsService', () => {
  let prisma: {
    user: { count: jest.Mock };
    analyticsDailySales: { findMany: jest.Mock; findUnique: jest.Mock };
    $queryRaw: jest.Mock;
  };
  let audit: { log: jest.Mock };
  let queue: { add: jest.Mock };
  let service: AnalyticsService;

  beforeEach(() => {
    prisma = {
      user: { count: jest.fn().mockResolvedValue(100) },
      analyticsDailySales: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue(null) },
      $queryRaw: jest.fn().mockResolvedValue([{ count: 0 }]),
    };
    audit = { log: jest.fn() };
    queue = { add: jest.fn().mockResolvedValue({ id: '42' }) };
    service = new AnalyticsService(prisma as never, audit as never, queue as never);
  });

  describe('salesReport', () => {
    it('reads the rollup rows of the inclusive range and fills days not computed with zeros', async () => {
      prisma.analyticsDailySales.findMany.mockResolvedValue([
        salesRow('2026-03-02', { paidOrders: 2, grossRevenue: d('300.00'), refunds: d('20.00') }),
      ]);

      const report = await service.salesReport('2026-03-01', '2026-03-03', ReportBucket.DAY);

      expect(prisma.analyticsDailySales.findMany).toHaveBeenCalledWith({
        where: { day: { gte: new Date('2026-03-01T00:00:00Z'), lt: new Date('2026-03-04T00:00:00Z') } },
        orderBy: { day: 'asc' },
      });
      expect(report.totals).toMatchObject({ paidOrders: 2, netRevenue: d('280'), averageOrderValue: d('140') });
      expect(report.buckets.map((bucket) => [bucket.firstDay, bucket.paidOrders])).toEqual([
        ['2026-03-01', 0],
        ['2026-03-02', 2],
        ['2026-03-03', 0],
      ]);
      expect(report.daysNotComputed).toBe(2);
      expect(report.refreshedAt).toEqual(new Date('2026-03-04T10:00:00Z'));
    });

    it('refuses an invalid range with BAD_REQUEST before reading anything', async () => {
      await expect(service.salesReport('2026-03-02', '2026-03-01', ReportBucket.DAY)).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.analyticsDailySales.findMany).not.toHaveBeenCalled();
    });
  });

  describe('dashboardSummary', () => {
    it("reports today's paid orders and revenue from today's UTC rollup row", async () => {
      prisma.analyticsDailySales.findUnique.mockResolvedValue(
        salesRow('2026-03-04', { paidOrders: 5, grossRevenue: d('1300.00'), refunds: d('50.00') }),
      );
      prisma.$queryRaw.mockResolvedValueOnce([{ count: 3 }]).mockResolvedValueOnce([{ count: 7 }]);

      const summary = await service.dashboardSummary(new Date('2026-03-04T23:30:00Z'));

      expect(prisma.analyticsDailySales.findUnique).toHaveBeenCalledWith({
        where: { day: new Date('2026-03-04T00:00:00Z') },
      });
      expect(summary).toEqual({
        totalUsers: 100,
        ordersToday: 5,
        revenueToday: d('1250'),
        grossRevenueToday: d('1300'),
        refundsToday: d('50'),
        lowStockProductCount: 3,
        lowStockVariantCount: 7,
      });
    });

    it('reports zeros before today was computed', async () => {
      const summary = await service.dashboardSummary(new Date('2026-03-04T00:01:00Z'));

      expect(summary).toMatchObject({ ordersToday: 0, revenueToday: d('0'), refundsToday: d('0') });
    });
  });

  describe('requestRebuild', () => {
    it('queues the rebuild of the half-open range on the maintenance queue, then audits who asked', async () => {
      const result = await service.requestRebuild('2026-01-01', '2026-01-31', 'admin1');

      expect(queue.add).toHaveBeenCalledWith(ANALYTICS_REBUILD_JOB, { from: '2026-01-01', to: '2026-02-01' });
      expect(audit.log).toHaveBeenCalledWith({
        entity: 'AnalyticsRollup',
        entityId: '42',
        action: 'CREATE',
        userId: 'admin1',
        details: { firstDay: '2026-01-01', lastDay: '2026-01-31', days: 31 },
      });
      expect(result).toEqual({ jobId: '42', firstDay: '2026-01-01', lastDay: '2026-01-31' });
    });

    it('queues nothing for a range over two years', async () => {
      await expect(service.requestRebuild('2020-01-01', '2026-01-01', 'admin1')).rejects.toThrow(
        'A report covers at most 731 days',
      );
      expect(queue.add).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });
  });
});
