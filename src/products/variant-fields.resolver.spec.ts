import { Test, TestingModule } from '@nestjs/testing';
import { VariantFieldsResolver } from './variant-fields.resolver';
import { PromotionLoader } from './loaders/promotion.loader';
import { Prisma } from '../generated/prisma/client';
import { Variant } from '../variant/entities/variant.entity';

const mockLoad = jest.fn();
const mockPromotionLoader = { loader: { load: mockLoad } };
const mockVariant = { id: 'var1', productId: 'prod1', sku: 'TSHIRT-M' } as unknown as Variant;

describe('VariantFieldsResolver', () => {
  let resolver: VariantFieldsResolver;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VariantFieldsResolver, { provide: PromotionLoader, useValue: mockPromotionLoader }],
    }).compile();

    resolver = module.get<VariantFieldsResolver>(VariantFieldsResolver);
    jest.clearAllMocks();
  });

  describe('discountedPrice', () => {
    it("should return the variant's discounted price, loaded by variant id", async () => {
      mockLoad.mockResolvedValue({
        discountedPrice: new Prisma.Decimal('5.00'),
        discountAmount: new Prisma.Decimal('14.99'),
      });

      const result = await resolver.discountedPrice(mockVariant, undefined);

      expect(mockLoad).toHaveBeenCalledWith({ userId: null, variantId: 'var1' });
      expect(result).toEqual(new Prisma.Decimal('5.00'));
    });

    it('should return null if discounted price is equal to price', async () => {
      mockLoad.mockResolvedValue({
        discountedPrice: new Prisma.Decimal('19.99'),
        discountAmount: new Prisma.Decimal(0),
      });

      const result = await resolver.discountedPrice(mockVariant, undefined);

      expect(result).toEqual(null);
    });
  });

  describe('appliedPromotion', () => {
    it('returns only what a customer may see of the promotion behind the price', async () => {
      mockLoad.mockResolvedValue({
        discountedPrice: new Prisma.Decimal(80),
        discountAmount: new Prisma.Decimal(20),
        promotion: {
          id: 'promo1',
          name: 'Summer Sale',
          description: '20% off',
          endsAt: new Date('2025-06-30'),
          usageLimit: 100,
          usedCount: 7,
          priority: 3,
        },
      });

      const result = await resolver.appliedPromotion(mockVariant, undefined);

      expect(mockLoad).toHaveBeenCalledWith({ userId: null, variantId: 'var1' });
      expect(result).toEqual({
        id: 'promo1',
        name: 'Summer Sale',
        description: '20% off',
        endsAt: new Date('2025-06-30'),
      });
    });

    it('should return null without a promotion', async () => {
      mockLoad.mockResolvedValue({ discountedPrice: new Prisma.Decimal(80), discountAmount: new Prisma.Decimal(0) });

      const result = await resolver.appliedPromotion(mockVariant, undefined);

      expect(result).toBeNull();
    });
  });

  describe('customerPrice and priceTiers', () => {
    const tiers = [
      { priceListId: 'l1', minQuantity: 1, unitPrice: new Prisma.Decimal(90), allowPromotions: false },
      { priceListId: 'l2', minQuantity: 10, unitPrice: new Prisma.Decimal(80), allowPromotions: true },
    ];

    it("gives the signed-in customer's tiers, loaded for that customer, without the list ids", async () => {
      mockLoad.mockResolvedValue({ discountAmount: new Prisma.Decimal(0), priceTiers: tiers });

      const first = await resolver.customerPrice(mockVariant, 'user1');
      const all = await resolver.priceTiers(mockVariant, 'user1');

      expect(mockLoad).toHaveBeenCalledWith({ userId: 'user1', variantId: 'var1' });
      expect(first).toEqual({ minQuantity: 1, unitPrice: new Prisma.Decimal(90), promotionsApply: false });
      expect(all).toEqual([
        { minQuantity: 1, unitPrice: new Prisma.Decimal(90), promotionsApply: false },
        { minQuantity: 10, unitPrice: new Prisma.Decimal(80), promotionsApply: true },
      ]);
    });

    it('gives a visitor null without loading anything, and a customer without a list null and []', async () => {
      expect(await resolver.customerPrice(mockVariant, undefined)).toBeNull();
      expect(await resolver.priceTiers(mockVariant, undefined)).toBeNull();
      expect(mockLoad).not.toHaveBeenCalled();

      mockLoad.mockResolvedValue({ discountAmount: new Prisma.Decimal(0), priceTiers: [] });
      expect(await resolver.customerPrice(mockVariant, 'user1')).toBeNull();
      expect(await resolver.priceTiers(mockVariant, 'user1')).toEqual([]);
    });
  });
});
