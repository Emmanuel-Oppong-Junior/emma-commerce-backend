import { Test, TestingModule } from '@nestjs/testing';
import { VariantFieldsResolver } from './variant-fields.resolver';
import { DiscountLoader } from './loaders/discount.loader';
import { DiscountService } from '../discount/discount.service';
import { Prisma } from '../generated/prisma/client';
import { DiscountType } from '../discount/enums/discount-type.enum';
import { Variant } from '../variant/entities/variant.entity';

const mockDiscountService = { findOneDiscount: jest.fn() };
const mockDiscountLoaderFn = jest.fn();
const mockDiscountLoader = { loader: { load: mockDiscountLoaderFn } };
const mockVariant = { id: 'var1', productId: 'prod1', sku: 'TSHIRT-M' } as unknown as Variant;

describe('VariantFieldsResolver', () => {
  let resolver: VariantFieldsResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VariantFieldsResolver,
        { provide: DiscountService, useValue: mockDiscountService },
        { provide: DiscountLoader, useValue: mockDiscountLoader },
      ],
    }).compile();

    resolver = module.get<VariantFieldsResolver>(VariantFieldsResolver);
    jest.clearAllMocks();
  });

  describe('discountedPrice', () => {
    it("should return the variant's discounted price, loaded by variant id", async () => {
      mockDiscountLoaderFn.mockResolvedValue({
        discountedPrice: new Prisma.Decimal('5.00'),
        discountAmount: new Prisma.Decimal('14.99'),
        discountId: 'disc1',
      });

      const result = await resolver.discountedPrice(mockVariant);

      expect(mockDiscountLoaderFn).toHaveBeenCalledWith('var1');
      expect(result).toEqual(new Prisma.Decimal('5.00'));
    });

    it('should return null if discounted price is equal to price', async () => {
      mockDiscountLoaderFn.mockResolvedValue({
        discountedPrice: new Prisma.Decimal('19.99'),
        discountAmount: new Prisma.Decimal(0),
        discountId: null,
      });

      const result = await resolver.discountedPrice(mockVariant);

      expect(result).toEqual(null);
    });
  });

  describe('appliedDiscount', () => {
    it('should return applied discount', async () => {
      const mockDiscount = {
        id: 'discount1',
        name: 'Summer Sale',
        description: '20% off',
        type: DiscountType.PERCENTAGE,
        value: new Prisma.Decimal(20),
        startDate: new Date('2025-06-01'),
        endDate: new Date('2025-06-30'),
        isActive: true,
        minimumPurchase: null,
      };
      mockDiscountLoaderFn.mockResolvedValue({ discountedPrice: 80, discountId: mockDiscount.id });
      mockDiscountService.findOneDiscount.mockResolvedValueOnce(mockDiscount);

      const result = await resolver.appliedDiscount(mockVariant);

      expect(mockDiscountLoaderFn).toHaveBeenCalledWith('var1');
      expect(mockDiscountService.findOneDiscount).toHaveBeenCalledWith(mockDiscount.id);
      expect(result).toEqual(mockDiscount);
    });

    it('should return null without a discount', async () => {
      mockDiscountLoaderFn.mockResolvedValue({ discountedPrice: 80, discountId: undefined });

      const result = await resolver.appliedDiscount(mockVariant);

      expect(result).toBeNull();
      expect(mockDiscountService.findOneDiscount).not.toHaveBeenCalled();
    });
  });
});
