import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryRepository } from './inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLog, Prisma } from '@prisma/client';

const mockInventoryRepository = {
  createLog: jest.fn(),
  findByProduct: jest.fn(),
  findByVariant: jest.fn(),
};

const mockPrisma = {
  product: { findUnique: jest.fn() },
  variant: { findUnique: jest.fn() },
  $transaction: jest.fn(),
};

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

describe('InventoryService', () => {
  let service: InventoryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: InventoryRepository, useValue: mockInventoryRepository },
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<InventoryService>(InventoryService);
    jest.clearAllMocks();
  });

  describe('restockProduct', () => {
    it('should restock a product and log the change', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'prod1', quantity: 100 });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const mockTx = {
          product: { update: jest.fn().mockResolvedValue({ quantity: 150 }) },
        };
        return cb(mockTx);
      });
      mockInventoryRepository.createLog.mockResolvedValue(mockLog);

      const result = await service.restockProduct({ productId: 'prod1', quantity: 50 }, 'admin1');

      expect(result).toEqual(mockLog);
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('should throw NotFoundException if product not found', async () => {
      mockPrisma.product.findUnique.mockResolvedValue(null);

      await expect(service.restockProduct({ productId: 'nonexistent', quantity: 10 }, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should use custom reason when provided', async () => {
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'prod1', quantity: 100 });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const mockTx = {
          product: { update: jest.fn().mockResolvedValue({ quantity: 120 }) },
        };
        return cb(mockTx);
      });
      mockInventoryRepository.createLog.mockResolvedValue({ ...mockLog, reason: 'Received shipment' });

      const result = await service.restockProduct(
        { productId: 'prod1', quantity: 20, reason: 'Received shipment' },
        'admin1',
      );

      expect(mockInventoryRepository.createLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'Received shipment' }),
      );
      expect(result.reason).toBe('Received shipment');
    });
  });

  describe('restockVariant', () => {
    it('should restock a variant and log the change', async () => {
      mockPrisma.variant.findUnique.mockResolvedValue({ id: 'var1', quantity: 10, productId: 'prod1' });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const mockTx = {
          variant: { update: jest.fn().mockResolvedValue({ quantity: 60 }) },
        };
        return cb(mockTx);
      });
      const variantLog = { ...mockLog, variantId: 'var1' };
      mockInventoryRepository.createLog.mockResolvedValue(variantLog);

      const result = await service.restockVariant({ variantId: 'var1', quantity: 50 }, 'admin1');

      expect(result.variantId).toBe('var1');
    });

    it('should throw NotFoundException if variant not found', async () => {
      mockPrisma.variant.findUnique.mockResolvedValue(null);

      await expect(service.restockVariant({ variantId: 'nonexistent', quantity: 10 }, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should use default reason when not provided', async () => {
      mockPrisma.variant.findUnique.mockResolvedValue({ id: 'var1', quantity: 5, productId: 'prod1' });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => {
        const mockTx = {
          variant: { update: jest.fn().mockResolvedValue({ quantity: 15 }) },
        };
        return cb(mockTx);
      });
      mockInventoryRepository.createLog.mockResolvedValue(mockLog);

      await service.restockVariant({ variantId: 'var1', quantity: 10 }, 'admin1');

      expect(mockInventoryRepository.createLog).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ reason: 'Manual restock' }),
      );
    });
  });

  describe('logInventoryChange', () => {
    it('should delegate to repository createLog', async () => {
      const mockTx = {} as Prisma.TransactionClient;
      mockInventoryRepository.createLog.mockResolvedValue(undefined);

      await service.logInventoryChange(mockTx, {
        productId: 'prod1',
        action: 'ORDER_DEDUCTION',
        quantityChange: -5,
        quantityAfter: 95,
      });

      expect(mockInventoryRepository.createLog).toHaveBeenCalledWith(
        mockTx,
        expect.objectContaining({ productId: 'prod1', action: 'ORDER_DEDUCTION' }),
      );
    });
  });

  describe('getProductLogs', () => {
    it('should return inventory logs for a product', async () => {
      mockInventoryRepository.findByProduct.mockResolvedValue([mockLog]);

      const result = await service.getProductLogs('prod1');

      expect(result).toEqual([mockLog]);
      expect(mockInventoryRepository.findByProduct).toHaveBeenCalledWith('prod1');
    });
  });

  describe('getVariantLogs', () => {
    it('should return inventory logs for a variant', async () => {
      const variantLog = { ...mockLog, variantId: 'var1' };
      mockInventoryRepository.findByVariant.mockResolvedValue([variantLog]);

      const result = await service.getVariantLogs('var1');

      expect(result).toEqual([variantLog]);
      expect(mockInventoryRepository.findByVariant).toHaveBeenCalledWith('var1');
    });
  });
});
