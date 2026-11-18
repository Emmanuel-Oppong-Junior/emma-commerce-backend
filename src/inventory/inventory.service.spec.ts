import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InventoryService } from './inventory.service';
import { InventoryRepository } from './inventory.repository';
import { PrismaService } from '../prisma/prisma.service';
import { InventoryLog, Prisma } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { createAuditServiceMock } from '../../test/helpers/audit.helper';

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
const mockAuditService = createAuditServiceMock();

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
        { provide: AuditService, useValue: mockAuditService },
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

  describe.each([
    {
      target: 'product',
      adjust: (s: InventoryService) =>
        s.adjustProductStock.bind(s) as (input: any, actorId: string) => Promise<InventoryLog>,
      idField: 'productId',
      found: { quantity: 7 },
      expectedLog: { productId: 'id1' },
    },
    {
      target: 'variant',
      adjust: (s: InventoryService) =>
        s.adjustVariantStock.bind(s) as (input: any, actorId: string) => Promise<InventoryLog>,
      idField: 'variantId',
      found: { quantity: 7, productId: 'prod1' },
      expectedLog: { productId: 'prod1', variantId: 'id1' },
    },
  ])('adjust $target stock', ({ target, adjust, idField, found, expectedLog }) => {
    const runWith = (count: number, row: object | null) => {
      const model = {
        updateMany: jest.fn().mockResolvedValue({ count }),
        findUnique: jest.fn().mockResolvedValue(row),
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb({ [target]: model }));
      return model;
    };

    it('moves stock by a signed delta only while it stays at or above zero, and logs an ADJUSTMENT', async () => {
      const model = runWith(1, found);
      mockInventoryRepository.createLog.mockResolvedValue(mockLog);

      await adjust(service)({ [idField]: 'id1', delta: -3, reason: 'Damaged in storage' }, 'admin1');

      expect(model.updateMany).toHaveBeenCalledWith({
        where: { id: 'id1', quantity: { gte: 3 } },
        data: { quantity: { increment: -3 } },
      });
      expect(mockInventoryRepository.createLog).toHaveBeenCalledWith(expect.anything(), {
        ...expectedLog,
        action: 'ADJUSTMENT',
        quantityChange: -3,
        quantityAfter: 7,
        reason: 'Damaged in storage',
        actorId: 'admin1',
      });
    });

    it('allows a positive correction without a stock floor', async () => {
      const model = runWith(1, found);

      await adjust(service)({ [idField]: 'id1', delta: 4, reason: 'Stock count' }, 'admin1');

      expect(model.updateMany).toHaveBeenCalledWith({
        where: { id: 'id1', quantity: { gte: 0 } },
        data: { quantity: { increment: 4 } },
      });
    });

    it('refuses to take stock below zero and writes no log', async () => {
      runWith(0, found);

      await expect(adjust(service)({ [idField]: 'id1', delta: -10, reason: 'Lost' }, 'admin1')).rejects.toThrow(
        new BadRequestException(`Cannot remove 10 units from ${target} "id1": only 7 in stock`),
      );
      expect(mockInventoryRepository.createLog).not.toHaveBeenCalled();
    });

    it('reports a missing target as not found', async () => {
      runWith(0, null);

      await expect(adjust(service)({ [idField]: 'id1', delta: -1, reason: 'Lost' }, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
      expect(mockInventoryRepository.createLog).not.toHaveBeenCalled();
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

  describe('audit trail', () => {
    const variantLog = { ...mockLog, id: 'log2', variantId: 'var1', action: 'ADJUSTMENT', quantityChange: -3 };

    it.each<[string, () => Promise<unknown>, InventoryLog, object]>([
      [
        'restockProduct',
        () => service.restockProduct({ productId: 'prod1', quantity: 50 }, 'admin1'),
        mockLog,
        {
          entity: 'Product',
          entityId: 'prod1',
          details: {
            inventoryLogId: 'log1',
            kind: 'RESTOCK',
            productId: 'prod1',
            quantityChange: 50,
            quantityAfter: 150,
            reason: 'Manual restock',
          },
        },
      ],
      [
        'restockVariant',
        () => service.restockVariant({ variantId: 'var1', quantity: 50 }, 'admin1'),
        { ...mockLog, variantId: 'var1' } as InventoryLog,
        {
          entity: 'Variant',
          entityId: 'var1',
          details: expect.objectContaining({ kind: 'RESTOCK', productId: 'prod1' }),
        },
      ],
      [
        'adjustProductStock',
        () => service.adjustProductStock({ productId: 'prod1', delta: -3, reason: 'Damaged' }, 'admin1'),
        { ...mockLog, action: 'ADJUSTMENT', quantityChange: -3 } as InventoryLog,
        {
          entity: 'Product',
          entityId: 'prod1',
          details: expect.objectContaining({ kind: 'ADJUSTMENT', quantityChange: -3 }),
        },
      ],
      [
        'adjustVariantStock',
        () => service.adjustVariantStock({ variantId: 'var1', delta: -3, reason: 'Damaged' }, 'admin1'),
        variantLog as InventoryLog,
        {
          entity: 'Variant',
          entityId: 'var1',
          details: expect.objectContaining({ inventoryLogId: 'log2', kind: 'ADJUSTMENT', quantityChange: -3 }),
        },
      ],
    ])('%s audits the stock change on the transaction that moved the stock', async (_name, act, log, expected) => {
      const tx = {
        product: {
          update: jest.fn().mockResolvedValue({ quantity: 150 }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ quantity: 147 }),
        },
        variant: {
          update: jest.fn().mockResolvedValue({ quantity: 150 }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUnique: jest.fn().mockResolvedValue({ quantity: 147, productId: 'prod1' }),
        },
      };
      mockPrisma.product.findUnique.mockResolvedValue({ id: 'prod1', quantity: 100 });
      mockPrisma.variant.findUnique.mockResolvedValue({ id: 'var1', quantity: 100, productId: 'prod1' });
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(tx));
      mockInventoryRepository.createLog.mockResolvedValue(log);

      await act();

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        { action: 'STOCK_ADJUSTMENT', userId: 'admin1', ...expected },
        tx,
      );
    });

    it('does not audit a refused adjustment', async () => {
      const model = {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUnique: jest.fn().mockResolvedValue({ quantity: 1 }),
      };
      mockPrisma.$transaction.mockImplementation(async (cb: any) => cb({ product: model }));

      await expect(
        service.adjustProductStock({ productId: 'prod1', delta: -5, reason: 'Lost' }, 'admin1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });
});
