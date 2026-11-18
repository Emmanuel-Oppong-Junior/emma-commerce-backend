import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CouponsRepository } from './coupons.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Coupon, Prisma } from '../generated/prisma/client';

const mockCoupon = {
  id: 'coupon1',
  code: 'SAVE10',
  discountType: 'PERCENTAGE',
  value: new Prisma.Decimal(10),
  usageLimit: 100,
  usedCount: 0,
  expiresAt: new Date('2027-01-01'),
  isActive: true,
  minimumOrderAmount: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Coupon;

const mockPrismaCoupon = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaCouponUsage = { findUnique: jest.fn(), create: jest.fn() };

const mockPrisma = { coupon: mockPrismaCoupon, couponUsage: mockPrismaCouponUsage };

describe('CouponsRepository', () => {
  let repository: CouponsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponsRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<CouponsRepository>(CouponsRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a coupon', async () => {
      mockPrismaCoupon.create.mockResolvedValue(mockCoupon);

      const result = await repository.create({ code: 'SAVE10', discountType: 'PERCENTAGE', value: 10 } as any);

      expect(result).toEqual(mockCoupon);
    });

    it('should throw ConflictException on P2002 (duplicate code)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaCoupon.create.mockRejectedValue(prismaError);

      await expect(repository.create({ code: 'DUP' } as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaCoupon.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ code: 'X' } as any)).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a coupon by ID', async () => {
      mockPrismaCoupon.findUnique.mockResolvedValue(mockCoupon);

      const result = await repository.findById('coupon1');

      expect(result).toEqual(mockCoupon);
    });

    it('should return null if not found', async () => {
      mockPrismaCoupon.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByCode', () => {
    it('should find a coupon by code', async () => {
      mockPrismaCoupon.findUnique.mockResolvedValue(mockCoupon);

      const result = await repository.findByCode('SAVE10');

      expect(result).toEqual(mockCoupon);
    });
  });

  describe('findAll', () => {
    it('should return all coupons', async () => {
      mockPrismaCoupon.findMany.mockResolvedValue([mockCoupon]);

      const result = await repository.findAll();

      expect(result).toEqual([mockCoupon]);
      expect(mockPrismaCoupon.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    });
  });

  describe('update', () => {
    it('should update a coupon', async () => {
      const updated = { ...mockCoupon, value: new Prisma.Decimal(20) };
      mockPrismaCoupon.update.mockResolvedValue(updated);

      const result = await repository.update('coupon1', { value: 20 } as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaCoupon.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaCoupon.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('coupon1', {})).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a coupon', async () => {
      mockPrismaCoupon.delete.mockResolvedValue(mockCoupon);

      const result = await repository.delete('coupon1');

      expect(result).toEqual(mockCoupon);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaCoupon.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors on delete', async () => {
      mockPrismaCoupon.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('coupon1')).rejects.toThrow('DB error');
    });
  });

  describe('hasUserUsedCoupon', () => {
    it('should return true if coupon usage exists', async () => {
      mockPrismaCouponUsage.findUnique.mockResolvedValue({ couponId: 'coupon1', userId: 'user1' });

      const result = await repository.hasUserUsedCoupon('coupon1', 'user1');

      expect(result).toBe(true);
    });

    it('should return false if coupon usage does not exist', async () => {
      mockPrismaCouponUsage.findUnique.mockResolvedValue(null);

      const result = await repository.hasUserUsedCoupon('coupon1', 'user1');

      expect(result).toBe(false);
    });
  });

  describe('recordUsage', () => {
    it('should create a usage record, increment usedCount and return the updated coupon', async () => {
      const updated = { id: 'coupon1', usedCount: 1 };
      const mockTx = {
        couponUsage: { create: jest.fn().mockResolvedValue(undefined) },
        coupon: { update: jest.fn().mockResolvedValue(updated) },
      };

      const result = await repository.recordUsage(mockTx as any, 'coupon1', 'user1', 'order1');

      expect(mockTx.couponUsage.create).toHaveBeenCalledWith({
        data: { couponId: 'coupon1', userId: 'user1', orderId: 'order1' },
      });
      expect(mockTx.coupon.update).toHaveBeenCalledWith({
        where: { id: 'coupon1' },
        data: { usedCount: { increment: 1 } },
      });
      expect(result).toBe(updated);
    });
  });

  describe('releaseUsage', () => {
    const mockTx = {
      couponUsage: { findUnique: jest.fn(), delete: jest.fn() },
      coupon: { update: jest.fn() },
    };

    beforeEach(() => jest.resetAllMocks());

    it("deletes the order's usage and decrements the coupon's usedCount", async () => {
      mockTx.couponUsage.findUnique.mockResolvedValue({ id: 'usage1', couponId: 'coupon1', orderId: 'order1' });

      await repository.releaseUsage(mockTx as any, 'order1');

      expect(mockTx.couponUsage.findUnique).toHaveBeenCalledWith({ where: { orderId: 'order1' } });
      expect(mockTx.couponUsage.delete).toHaveBeenCalledWith({ where: { id: 'usage1' } });
      expect(mockTx.coupon.update).toHaveBeenCalledWith({
        where: { id: 'coupon1' },
        data: { usedCount: { decrement: 1 } },
      });
    });

    it('does nothing when the order used no coupon', async () => {
      mockTx.couponUsage.findUnique.mockResolvedValue(null);

      await repository.releaseUsage(mockTx as any, 'order1');

      expect(mockTx.couponUsage.delete).not.toHaveBeenCalled();
      expect(mockTx.coupon.update).not.toHaveBeenCalled();
    });
  });
});
