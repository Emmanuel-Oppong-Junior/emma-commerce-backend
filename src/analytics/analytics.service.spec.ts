import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  user: {
    count: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

const salesRow = (values: {
  grossRevenue: string;
  refunds: string;
  netRevenue: string;
  itemSales: string;
  orderCount: number;
  averageOrderValue: string;
}) => ({
  ...values,
  grossRevenue: new Prisma.Decimal(values.grossRevenue),
  refunds: new Prisma.Decimal(values.refunds),
  netRevenue: new Prisma.Decimal(values.netRevenue),
  itemSales: new Prisma.Decimal(values.itemSales),
  averageOrderValue: new Prisma.Decimal(values.averageOrderValue),
});

/** Joins the static SQL of a tagged-template `$queryRaw` call, inlining nested Prisma.sql fragments. */
const sqlOf = (call: unknown[]): string => {
  const [strings, ...values] = call as [TemplateStringsArray, ...unknown[]];
  return strings.reduce((sql, part, i) => {
    const value = values[i - 1];
    const fragment = typeof value === 'object' && value !== null && 'sql' in value ? (value as Prisma.Sql).sql : '?';
    return sql + fragment + part;
  });
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AnalyticsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get<AnalyticsService>(AnalyticsService);
    jest.clearAllMocks();
  });

  describe('getSalesReport', () => {
    it('maps gross revenue, refunds and net revenue computed in SQL, with totalRevenue equal to net revenue', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        salesRow({
          grossRevenue: '375.00',
          refunds: '40.00',
          netRevenue: '335.00',
          itemSales: '340.00',
          orderCount: 3,
          averageOrderValue: '125.00',
        }),
      ]);

      const result = await service.getSalesReport(new Date('2025-01-01'), new Date('2025-01-31'));

      expect(result).toEqual({
        grossRevenue: new Prisma.Decimal('375'),
        refunds: new Prisma.Decimal('40'),
        netRevenue: new Prisma.Decimal('335'),
        totalRevenue: new Prisma.Decimal('335'),
        itemSales: new Prisma.Decimal('340'),
        orderCount: 3,
        averageOrderValue: new Prisma.Decimal('125'),
      });
    });

    it('counts only accepted payments and processed refunds against them, within the period', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        salesRow({
          grossRevenue: '0',
          refunds: '0',
          netRevenue: '0',
          itemSales: '0',
          orderCount: 0,
          averageOrderValue: '0',
        }),
      ]);
      const start = new Date('2025-01-01');
      const end = new Date('2025-01-31');

      const result = await service.getSalesReport(start, end);

      expect(result).toMatchObject({
        grossRevenue: new Prisma.Decimal('0'),
        netRevenue: new Prisma.Decimal('0'),
        orderCount: 0,
        averageOrderValue: new Prisma.Decimal('0'),
      });
      const call = mockPrisma.$queryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain(`pa.status = 'CAPTURED' AND pa."reviewReason" IS NULL AND pa.deleted = false`);
      expect(sql).toContain(`r.status = 'PROCESSED'`);
      expect(sql).not.toContain('"Order"');
      expect(call.slice(1)).toEqual(expect.arrayContaining([start, end]));
    });
  });

  describe('getTopProducts', () => {
    it('maps top products of paid orders', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          productId: 'p1',
          productName: 'T-Shirt',
          totalQuantitySold: BigInt(50),
          totalRevenue: new Prisma.Decimal('999.50'),
        },
        {
          productId: 'p2',
          productName: 'Hoodie',
          totalQuantitySold: BigInt(30),
          totalRevenue: new Prisma.Decimal(1500),
        },
      ]);

      const result = await service.getTopProducts(5);

      expect(result).toEqual([
        { productId: 'p1', productName: 'T-Shirt', totalQuantitySold: 50, totalRevenue: new Prisma.Decimal('999.5') },
        { productId: 'p2', productName: 'Hoodie', totalQuantitySold: 30, totalRevenue: new Prisma.Decimal('1500') },
      ]);
      expect(sqlOf(mockPrisma.$queryRaw.mock.calls[0])).toContain(`pa."reviewReason" IS NULL`);
    });

    it('returns an empty array when nothing was paid', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      expect(await service.getTopProducts(5)).toEqual([]);
    });
  });

  describe('getRevenueByCategory', () => {
    it('maps category item sales of paid orders', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        {
          categoryId: 'cat1',
          categoryName: 'Clothing',
          totalRevenue: new Prisma.Decimal(3000),
          orderCount: BigInt(15),
        },
        { categoryId: null, categoryName: null, totalRevenue: new Prisma.Decimal(500), orderCount: BigInt(5) },
      ]);

      const result = await service.getRevenueByCategory();

      expect(result).toEqual([
        { categoryId: 'cat1', categoryName: 'Clothing', totalRevenue: new Prisma.Decimal('3000'), orderCount: 15 },
        { categoryId: undefined, categoryName: undefined, totalRevenue: new Prisma.Decimal('500'), orderCount: 5 },
      ]);
      expect(sqlOf(mockPrisma.$queryRaw.mock.calls[0])).toContain(`pa."reviewReason" IS NULL`);
    });
  });

  describe('getDashboardSummary', () => {
    it("reports today's paid orders and revenue from the sales report since the start of today", async () => {
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "Product"')) return Promise.resolve([{ count: BigInt(3) }]);
        if (sql.includes('FROM "Variant"')) return Promise.resolve([{ count: BigInt(7) }]);
        return Promise.resolve([
          salesRow({
            grossRevenue: '1300.00',
            refunds: '50.00',
            netRevenue: '1250.00',
            itemSales: '1200.00',
            orderCount: 5,
            averageOrderValue: '260.00',
          }),
        ]);
      });

      const result = await service.getDashboardSummary();

      expect(result).toEqual({
        totalUsers: 100,
        ordersToday: 5,
        revenueToday: new Prisma.Decimal('1250'),
        grossRevenueToday: new Prisma.Decimal('1300'),
        refundsToday: new Prisma.Decimal('50'),
        lowStockProductCount: 3,
        lowStockVariantCount: 7,
      });
      const salesCall = mockPrisma.$queryRaw.mock.calls.find((call) => sqlOf(call).includes('"recognisedAt"'))!;
      const [start, end] = salesCall.slice(1).filter((value: unknown) => value instanceof Date) as Date[];
      expect(start.getHours()).toBe(0);
      expect(start.getMinutes()).toBe(0);
      expect(end.getTime()).toBeGreaterThanOrEqual(start.getTime());
    });

    it('reports zero revenue today when nothing was paid', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FROM "Product"') || sql.includes('FROM "Variant"')) {
          return Promise.resolve([{ count: BigInt(0) }]);
        }
        return Promise.resolve([
          salesRow({
            grossRevenue: '0',
            refunds: '0',
            netRevenue: '0',
            itemSales: '0',
            orderCount: 0,
            averageOrderValue: '0',
          }),
        ]);
      });

      const result = await service.getDashboardSummary();

      expect(result).toMatchObject({
        totalUsers: 0,
        ordersToday: 0,
        revenueToday: new Prisma.Decimal('0'),
        refundsToday: new Prisma.Decimal('0'),
      });
    });
  });
});
