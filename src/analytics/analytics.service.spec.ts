import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsService } from './analytics.service';
import { PrismaService } from '../prisma/prisma.service';

const mockPrisma = {
  order: {
    aggregate: jest.fn(),
    count: jest.fn(),
  },
  user: {
    count: jest.fn(),
  },
  $queryRaw: jest.fn(),
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
    it('should return sales report with totals', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { totalAmount: 5000 },
        _count: { id: 20 },
        _avg: { totalAmount: 250 },
      });

      const result = await service.getSalesReport(new Date('2025-01-01'), new Date('2025-01-31'));

      expect(result).toEqual({
        totalRevenue: 5000,
        orderCount: 20,
        averageOrderValue: 250,
      });
      expect(mockPrisma.order.aggregate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: 'CANCELLED' }, deleted: false }),
        }),
      );
    });

    it('should return zeros when there are no orders', async () => {
      mockPrisma.order.aggregate.mockResolvedValue({
        _sum: { totalAmount: null },
        _count: { id: 0 },
        _avg: { totalAmount: null },
      });

      const result = await service.getSalesReport(new Date('2025-01-01'), new Date('2025-01-31'));

      expect(result).toEqual({ totalRevenue: 0, orderCount: 0, averageOrderValue: 0 });
    });
  });

  describe('getTopProducts', () => {
    it('should return top products with mapped values', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { productId: 'p1', productName: 'T-Shirt', totalQuantitySold: BigInt(50), totalRevenue: 999.5 },
        { productId: 'p2', productName: 'Hoodie', totalQuantitySold: BigInt(30), totalRevenue: 1500 },
      ]);

      const result = await service.getTopProducts(5);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        productId: 'p1',
        productName: 'T-Shirt',
        totalQuantitySold: 50,
        totalRevenue: 999.5,
      });
      expect(result[1].productName).toBe('Hoodie');
    });

    it('should return empty array when no products', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await service.getTopProducts(5);

      expect(result).toEqual([]);
    });
  });

  describe('getRevenueByCategory', () => {
    it('should return revenue by category with mapped values', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([
        { categoryId: 'cat1', categoryName: 'Clothing', totalRevenue: 3000, orderCount: BigInt(15) },
        { categoryId: null, categoryName: null, totalRevenue: 500, orderCount: BigInt(5) },
      ]);

      const result = await service.getRevenueByCategory();

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        categoryId: 'cat1',
        categoryName: 'Clothing',
        totalRevenue: 3000,
        orderCount: 15,
      });
      expect(result[1].categoryId).toBeUndefined();
      expect(result[1].categoryName).toBeUndefined();
    });
  });

  describe('getDashboardSummary', () => {
    it('should return dashboard summary with all metrics', async () => {
      mockPrisma.user.count.mockResolvedValue(100);
      mockPrisma.order.count.mockResolvedValue(5);
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { totalAmount: 1250 } });
      // Two $queryRaw calls: lowStockProducts and lowStockVariants
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ count: BigInt(3) }]).mockResolvedValueOnce([{ count: BigInt(7) }]);

      const result = await service.getDashboardSummary();

      expect(result).toEqual({
        totalUsers: 100,
        ordersToday: 5,
        revenueToday: 1250,
        lowStockProductCount: 3,
        lowStockVariantCount: 7,
      });
    });

    it('should handle zero revenue today', async () => {
      mockPrisma.user.count.mockResolvedValue(0);
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.order.aggregate.mockResolvedValue({ _sum: { totalAmount: null } });
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ count: BigInt(0) }]).mockResolvedValueOnce([{ count: BigInt(0) }]);

      const result = await service.getDashboardSummary();

      expect(result.revenueToday).toBe(0);
      expect(result.totalUsers).toBe(0);
    });
  });
});
