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

const mockPrismaProduct = { update: jest.fn() };
const mockPrismaVariant = { update: jest.fn() };

const mockPrisma = {
  inventoryLog: mockPrismaInventoryLog,
  product: mockPrismaProduct,
  variant: mockPrismaVariant,
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
        action: 'RESTOCK' as any,
        quantityChange: 50,
        quantityAfter: 150,
        reason: 'Manual restock',
        actorId: 'admin1',
      });

      expect(result).toEqual(mockLog);
      expect(mockTx.inventoryLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ productId: 'prod1', action: 'RESTOCK' }),
      });
    });

    it('should create a log using prisma service directly', async () => {
      mockPrismaInventoryLog.create.mockResolvedValue(mockLog);

      const result = await repository.createLog(mockPrisma as any, {
        productId: 'prod1',
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

  describe('incrementProductStock', () => {
    it('should increment product quantity and return new quantity', async () => {
      mockPrismaProduct.update.mockResolvedValue({ quantity: 150 });

      const result = await repository.incrementProductStock('prod1', 50);

      expect(result).toEqual({ quantity: 150 });
      expect(mockPrismaProduct.update).toHaveBeenCalledWith({
        where: { id: 'prod1' },
        data: { quantity: { increment: 50 } },
        select: { quantity: true },
      });
    });
  });

  describe('incrementVariantStock', () => {
    it('should increment variant quantity and return new quantity', async () => {
      mockPrismaVariant.update.mockResolvedValue({ quantity: 30 });

      const result = await repository.incrementVariantStock('var1', 20);

      expect(result).toEqual({ quantity: 30 });
      expect(mockPrismaVariant.update).toHaveBeenCalledWith({
        where: { id: 'var1' },
        data: { quantity: { increment: 20 } },
        select: { quantity: true },
      });
    });
  });

  describe('findLowStockProducts', () => {
    it('should return low stock products using default threshold', async () => {
      const mockProducts = [{ id: 'prod1', name: 'T-Shirt', quantity: 3, lowStockAlert: 5 }];
      mockPrisma.$queryRaw.mockResolvedValue(mockProducts);

      const result = await repository.findLowStockProducts();

      expect(result).toEqual(mockProducts);
      expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    });

    it('should return low stock products using a custom threshold', async () => {
      const mockProducts = [{ id: 'prod1', name: 'Widget', quantity: 2, lowStockAlert: null }];
      mockPrisma.$queryRaw.mockResolvedValue(mockProducts);

      const result = await repository.findLowStockProducts(10);

      expect(result).toEqual(mockProducts);
    });
  });

  describe('findLowStockVariants', () => {
    it('should return low stock variants', async () => {
      const mockVariants = [{ id: 'var1', productId: 'prod1', quantity: 1, lowStockThreshold: 5 }];
      mockPrisma.$queryRaw.mockResolvedValue(mockVariants);

      const result = await repository.findLowStockVariants();

      expect(result).toEqual(mockVariants);
    });

    it('should pass custom threshold', async () => {
      mockPrisma.$queryRaw.mockResolvedValue([]);

      const result = await repository.findLowStockVariants(3);

      expect(result).toEqual([]);
    });
  });
});
