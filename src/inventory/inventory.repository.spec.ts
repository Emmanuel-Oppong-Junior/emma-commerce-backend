import { Test, TestingModule } from '@nestjs/testing';
import { InventoryRepository } from './inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLog } from '../generated/prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockLog = {
  id: 'log1',
  productId: 'prod1',
  variantId: null,
  action: 'RESTOCK',
  quantityChange: 50,
  quantityAfter: 150,
  reason: 'Manual restock',
  actorId: 'admin1',
  createdAt: fixedDate,
} as unknown as InventoryLog;

const mockPrismaInventoryLog = {
  create: jest.fn(),
  findMany: jest.fn(),
};

const mockPrisma = {
  inventoryLog: mockPrismaInventoryLog,
  $queryRaw: jest.fn(),
};

describe('InventoryRepository', () => {
  let repository: InventoryRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [InventoryRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<InventoryRepository>(InventoryRepository);
    jest.clearAllMocks();
  });

  describe('createLog', () => {
    it('should create an inventory log via transaction client', async () => {
      const mockTx = { inventoryLog: { create: jest.fn().mockResolvedValue(mockLog) } };

      const result = await repository.createLog(mockTx as any, {
        productId: 'prod1',
        variantId: 'var1',
        action: 'RESTOCK' as any,
        quantityChange: 50,
        quantityAfter: 150,
        reason: 'Manual restock',
        actorId: 'admin1',
      });

      expect(result).toEqual(mockLog);
      expect(mockTx.inventoryLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ productId: 'prod1', variantId: 'var1', action: 'RESTOCK' }),
      });
    });

    it('should create a log using prisma service directly', async () => {
      mockPrismaInventoryLog.create.mockResolvedValue(mockLog);

      const result = await repository.createLog(mockPrisma as any, {
        productId: 'prod1',
        variantId: 'var1',
        action: 'ORDER_DEDUCTION' as any,
        quantityChange: -5,
        quantityAfter: 95,
      });

      expect(result).toEqual(mockLog);
    });
  });

  describe('findByProduct', () => {
    it('should return logs for a product ordered by date desc', async () => {
      mockPrismaInventoryLog.findMany.mockResolvedValue([mockLog]);

      const result = await repository.findByProduct('prod1');

      expect(result).toEqual([mockLog]);
      expect(mockPrismaInventoryLog.findMany).toHaveBeenCalledWith({
        where: { productId: 'prod1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findByVariant', () => {
    it('should return logs for a variant ordered by date desc', async () => {
      const variantLog = { ...mockLog, variantId: 'var1' };
      mockPrismaInventoryLog.findMany.mockResolvedValue([variantLog]);

      const result = await repository.findByVariant('var1');

      expect(result).toEqual([variantLog]);
      expect(mockPrismaInventoryLog.findMany).toHaveBeenCalledWith({
        where: { variantId: 'var1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findLowStockVariants', () => {
    it('should return low stock variants using the default threshold', async () => {
      const mockVariants = [{ id: 'var1', productId: 'prod1', sku: 'TSHIRT-M', quantity: 1, lowStockThreshold: 5 }];
      mockPrisma.$queryRaw.mockResolvedValue(mockVariants);

      const result = await repository.findLowStockVariants();

      expect(result).toEqual(mockVariants);
      const [, threshold] = mockPrisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, unknown];
      expect(threshold).toBe(5);
    });

    it('should pass custom threshold', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await repository.findLowStockVariants(3);

      expect(result).toEqual([]);
      const [, threshold] = mockPrisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, unknown];
      expect(threshold).toBe(3);
    });

    it('only reports active variants of active products', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      await repository.findLowStockVariants();

      const [sql] = mockPrisma.$queryRaw.mock.calls[0] as [TemplateStringsArray];
      const query = sql.join('?');
      expect(query).toContain('FROM "Variant" v JOIN "Product" p ON p.id = v."productId"');
      expect(query).toContain('v."isActive" AND p."isActive"');
    });
  });
});
