import { Test, TestingModule } from '@nestjs/testing';
import { CouponsService } from './coupons.service';
import { CouponsRepository } from './coupons.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Coupon, Prisma } from '@prisma/client';
import { CreateCouponInput } from './dto/create-coupon.input';
import { DiscountTypeEnum } from './enums/discount-type.enum';

const mockCouponsRepository = {
  create: jest.fn(),
  findById: jest.fn(),
  findByCode: jest.fn(),
  findAll: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  hasUserUsedCoupon: jest.fn(),
  recordUsage: jest.fn(),
  releaseUsage: jest.fn(),
};

const fixedDate = new Date('2026-12-31T00:00:00.000Z');

const mockCoupon = {
  id: 'coupon1',
  code: 'SAVE10',
  discountType: DiscountTypeEnum.PERCENTAGE,
  value: new Prisma.Decimal(10),
  usageLimit: 100,
  usedCount: 0,
  expiresAt: fixedDate,
  isActive: true,
  minimumOrderAmount: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Coupon;

describe('CouponsService', () => {
  let service: CouponsService;
  let couponsRepository: jest.Mocked<CouponsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CouponsService, { provide: CouponsRepository, useValue: mockCouponsRepository }],
    }).compile();

    service = module.get<CouponsService>(CouponsService);
    couponsRepository = module.get<CouponsRepository>(CouponsRepository) as jest.Mocked<CouponsRepository>;
    jest.clearAllMocks();
  });

  describe('createCoupon', () => {
    it('should create a coupon with uppercased code', async () => {
      const input: CreateCouponInput = {
        code: 'save10',
        discountType: DiscountTypeEnum.PERCENTAGE,
        value: 10,
        isActive: true,
      };
      mockCouponsRepository.create.mockResolvedValue(mockCoupon);

      const result = await service.createCoupon(input);

      expect(couponsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'SAVE10', isActive: true }),
      );
      expect(result).toEqual(mockCoupon);
    });

    it('should default isActive to true if not provided', async () => {
      const input: CreateCouponInput = { code: 'NEW', discountType: DiscountTypeEnum.FLAT, value: 5 };
      mockCouponsRepository.create.mockResolvedValue({ ...mockCoupon, isActive: true });

      await service.createCoupon(input);

      expect(couponsRepository.create).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    });
  });

  describe('updateCoupon', () => {
    it('should update a coupon successfully', async () => {
      const updated = { ...mockCoupon, value: new Prisma.Decimal(20) };
      mockCouponsRepository.findById.mockResolvedValue(mockCoupon);
      mockCouponsRepository.update.mockResolvedValue(updated);

      const result = await service.updateCoupon('coupon1', { value: 20 });

      expect(result).toEqual(updated);
    });

    it('should uppercase the code when updating', async () => {
      mockCouponsRepository.findById.mockResolvedValue(mockCoupon);
      mockCouponsRepository.update.mockResolvedValue(mockCoupon);

      await service.updateCoupon('coupon1', { code: 'newsave' });

      expect(couponsRepository.update).toHaveBeenCalledWith('coupon1', expect.objectContaining({ code: 'NEWSAVE' }));
    });

    it('should throw NotFoundException if coupon does not exist', async () => {
      mockCouponsRepository.findById.mockResolvedValue(null);

      await expect(service.updateCoupon('nonexistent', { value: 20 })).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteCoupon', () => {
    it('should delete a coupon', async () => {
      mockCouponsRepository.delete.mockResolvedValue(mockCoupon);

      const result = await service.deleteCoupon('coupon1');

      expect(couponsRepository.delete).toHaveBeenCalledWith('coupon1');
      expect(result).toEqual(mockCoupon);
    });
  });

  describe('findAll', () => {
    it('should return all coupons', async () => {
      mockCouponsRepository.findAll.mockResolvedValue([mockCoupon]);

      const result = await service.findAll();

      expect(result).toEqual([mockCoupon]);
    });
  });

  describe('findOne', () => {
    it('should return a coupon by ID', async () => {
      mockCouponsRepository.findById.mockResolvedValue(mockCoupon);

      const result = await service.findOne('coupon1');

      expect(result).toEqual(mockCoupon);
    });

    it('should throw NotFoundException if coupon not found', async () => {
      mockCouponsRepository.findById.mockResolvedValue(null);

      await expect(service.findOne('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('validateCoupon', () => {
    const userId = 'user1';
    const orderTotal = 100;

    it('should validate a valid coupon and return discount amount for PERCENTAGE type', async () => {
      mockCouponsRepository.findByCode.mockResolvedValue(mockCoupon);
      mockCouponsRepository.hasUserUsedCoupon.mockResolvedValue(false);

      const result = await service.validateCoupon('SAVE10', userId, orderTotal);

      expect(result.discountAmount).toBe(10);
      expect(result.coupon).toEqual(mockCoupon);
    });

    it('should validate a FLAT discount coupon', async () => {
      const flatCoupon = { ...mockCoupon, discountType: DiscountTypeEnum.FLAT, value: new Prisma.Decimal(15) };
      mockCouponsRepository.findByCode.mockResolvedValue(flatCoupon);
      mockCouponsRepository.hasUserUsedCoupon.mockResolvedValue(false);

      const result = await service.validateCoupon('FLAT15', userId, orderTotal);

      expect(result.discountAmount).toBe(15);
    });

    it('should cap FLAT discount at order total', async () => {
      const flatCoupon = { ...mockCoupon, discountType: DiscountTypeEnum.FLAT, value: new Prisma.Decimal(200) };
      mockCouponsRepository.findByCode.mockResolvedValue(flatCoupon);
      mockCouponsRepository.hasUserUsedCoupon.mockResolvedValue(false);

      const result = await service.validateCoupon('FLAT200', userId, 50);

      expect(result.discountAmount).toBe(50);
    });

    it('should throw NotFoundException if coupon code not found', async () => {
      mockCouponsRepository.findByCode.mockResolvedValue(null);

      await expect(service.validateCoupon('INVALID', userId, orderTotal)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if coupon is inactive', async () => {
      mockCouponsRepository.findByCode.mockResolvedValue({ ...mockCoupon, isActive: false });

      await expect(service.validateCoupon('SAVE10', userId, orderTotal)).rejects.toThrow(
        'This coupon is no longer active',
      );
    });

    it('should throw BadRequestException if coupon is expired', async () => {
      const expiredCoupon = { ...mockCoupon, expiresAt: new Date('2020-01-01') };
      mockCouponsRepository.findByCode.mockResolvedValue(expiredCoupon);

      await expect(service.validateCoupon('SAVE10', userId, orderTotal)).rejects.toThrow('This coupon has expired');
    });

    it('should throw BadRequestException if usage limit reached', async () => {
      const fullCoupon = { ...mockCoupon, usageLimit: 10, usedCount: 10 };
      mockCouponsRepository.findByCode.mockResolvedValue(fullCoupon);

      await expect(service.validateCoupon('SAVE10', userId, orderTotal)).rejects.toThrow(
        'This coupon has reached its usage limit',
      );
    });

    it('should throw BadRequestException if order total below minimum', async () => {
      const couponWithMin = { ...mockCoupon, minimumOrderAmount: new Prisma.Decimal(200) };
      mockCouponsRepository.findByCode.mockResolvedValue(couponWithMin);

      await expect(service.validateCoupon('SAVE10', userId, 50)).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if user already used coupon', async () => {
      mockCouponsRepository.findByCode.mockResolvedValue(mockCoupon);
      mockCouponsRepository.hasUserUsedCoupon.mockResolvedValue(true);

      await expect(service.validateCoupon('SAVE10', userId, orderTotal)).rejects.toThrow(
        'You have already used this coupon',
      );
    });

    it('should not check usage limit when usageLimit is null', async () => {
      const unlimitedCoupon = { ...mockCoupon, usageLimit: null };
      mockCouponsRepository.findByCode.mockResolvedValue(unlimitedCoupon);
      mockCouponsRepository.hasUserUsedCoupon.mockResolvedValue(false);

      const result = await service.validateCoupon('SAVE10', userId, orderTotal);

      expect(result.discountAmount).toBe(10);
    });
  });

  describe('recordUsage', () => {
    const mockTx = {} as Prisma.TransactionClient;
    const afterIncrement = (overrides: Partial<Coupon>) => ({ ...mockCoupon, expiresAt: null, ...overrides });

    it('should delegate to the repository', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(afterIncrement({ usedCount: 1 }));

      await service.recordUsage(mockTx, 'coupon1', 'user1', 'order1');

      expect(couponsRepository.recordUsage).toHaveBeenCalledWith(mockTx, 'coupon1', 'user1', 'order1');
    });

    it('accepts the use that reaches the limit exactly', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(afterIncrement({ usageLimit: 10, usedCount: 10 }));

      await expect(service.recordUsage(mockTx, 'coupon1', 'user1', 'order1')).resolves.toBeUndefined();
    });

    it('rejects the use when a concurrent checkout already took the last one', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(afterIncrement({ usageLimit: 10, usedCount: 11 }));

      await expect(service.recordUsage(mockTx, 'coupon1', 'user1', 'order1')).rejects.toThrow(
        new BadRequestException('This coupon has reached its usage limit'),
      );
    });

    it('accepts any number of uses when the coupon has no limit', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(afterIncrement({ usageLimit: null, usedCount: 5000 }));

      await expect(service.recordUsage(mockTx, 'coupon1', 'user1', 'order1')).resolves.toBeUndefined();
    });

    it('rejects the use when the coupon was deactivated after it was validated', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(afterIncrement({ isActive: false, usedCount: 1 }));

      await expect(service.recordUsage(mockTx, 'coupon1', 'user1', 'order1')).rejects.toThrow(BadRequestException);
    });

    it('rejects the use when the coupon expired after it was validated', async () => {
      mockCouponsRepository.recordUsage.mockResolvedValue(
        afterIncrement({ expiresAt: new Date(Date.now() - 1000), usedCount: 1 }),
      );

      await expect(service.recordUsage(mockTx, 'coupon1', 'user1', 'order1')).rejects.toThrow(
        new BadRequestException('This coupon has expired'),
      );
    });
  });

  describe('releaseUsage', () => {
    it("delegates to the repository with the caller's transaction", async () => {
      const mockTx = {} as Prisma.TransactionClient;

      await service.releaseUsage(mockTx, 'order1');

      expect(couponsRepository.releaseUsage).toHaveBeenCalledWith(mockTx, 'order1');
    });
  });
});
