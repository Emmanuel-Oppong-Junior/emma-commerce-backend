import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ReturnsRepository } from './returns.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, ReturnRequest } from '@prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockReturnRequest = {
  id: 'return1',
  orderId: 'order1',
  userId: 'user1',
  reason: 'Defective item',
  status: 'PENDING',
  refundAmount: null,
  adminNote: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
} as unknown as ReturnRequest;

const mockPrismaReturnRequest = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
};

const mockPrisma = { returnRequest: mockPrismaReturnRequest };

describe('ReturnsRepository', () => {
  let repository: ReturnsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReturnsRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<ReturnsRepository>(ReturnsRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a return request', async () => {
      mockPrismaReturnRequest.create.mockResolvedValue(mockReturnRequest);

      const result = await repository.create({ orderId: 'order1', userId: 'user1', reason: 'Defective item' });

      expect(result).toEqual(mockReturnRequest);
      expect(mockPrismaReturnRequest.create).toHaveBeenCalledWith({
        data: { orderId: 'order1', userId: 'user1', reason: 'Defective item' },
      });
    });
  });

  describe('findById', () => {
    it('should find a return request by ID', async () => {
      mockPrismaReturnRequest.findUnique.mockResolvedValue(mockReturnRequest);

      const result = await repository.findById('return1');

      expect(result).toEqual(mockReturnRequest);
    });

    it('should return null if not found', async () => {
      mockPrismaReturnRequest.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByOrder', () => {
    it('should return all return requests for an order', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findByOrder('order1');

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({ where: { orderId: 'order1' } });
    });
  });

  describe('findByUser', () => {
    it('should return all return requests for a user ordered by date desc', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({
        where: { userId: 'user1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('findAll', () => {
    it('should return all return requests ordered by date desc', async () => {
      mockPrismaReturnRequest.findMany.mockResolvedValue([mockReturnRequest]);

      const result = await repository.findAll();

      expect(result).toEqual([mockReturnRequest]);
      expect(mockPrismaReturnRequest.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    });
  });

  describe('updateStatus', () => {
    it('should update return request status', async () => {
      const updated = { ...mockReturnRequest, status: 'APPROVED', refundAmount: 50 };
      mockPrismaReturnRequest.update.mockResolvedValue(updated);

      const result = await repository.updateStatus('return1', 'APPROVED' as any, 50, 'Approved by admin');

      expect(result).toEqual(updated);
      expect(mockPrismaReturnRequest.update).toHaveBeenCalledWith({
        where: { id: 'return1' },
        data: { status: 'APPROVED', refundAmount: 50, adminNote: 'Approved by admin' },
      });
    });

    it('should update status without optional fields', async () => {
      const updated = { ...mockReturnRequest, status: 'REFUNDED' };
      mockPrismaReturnRequest.update.mockResolvedValue(updated);

      const result = await repository.updateStatus('return1', 'REFUNDED' as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaReturnRequest.update.mockRejectedValue(prismaError);

      await expect(repository.updateStatus('nonexistent', 'APPROVED' as any)).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaReturnRequest.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.updateStatus('return1', 'APPROVED' as any)).rejects.toThrow('DB error');
    });
  });

  describe('restoreOrderStock', () => {
    it('should restore stock for all order items', async () => {
      const mockOrderItems = [
        { productId: 'prod1', quantity: 2 },
        { productId: 'prod2', quantity: 1 },
      ];
      const mockTx = {
        orderItem: { findMany: jest.fn().mockResolvedValue(mockOrderItems) },
        product: { update: jest.fn().mockResolvedValue(undefined) },
      };

      await repository.restoreOrderStock(mockTx as any, 'order1');

      expect(mockTx.orderItem.findMany).toHaveBeenCalledWith({ where: { orderId: 'order1' } });
      expect(mockTx.product.update).toHaveBeenCalledTimes(2);
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: 'prod1' },
        data: { quantity: { increment: 2 } },
      });
    });

    it('should handle empty order items', async () => {
      const mockTx = {
        orderItem: { findMany: jest.fn().mockResolvedValue([]) },
        product: { update: jest.fn() },
      };

      await repository.restoreOrderStock(mockTx as any, 'order1');

      expect(mockTx.product.update).not.toHaveBeenCalled();
    });
  });
});
