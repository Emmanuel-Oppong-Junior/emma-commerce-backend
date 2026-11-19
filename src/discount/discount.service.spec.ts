import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { DiscountService } from './discount.service';
import { DiscountRepository } from './discount.repository';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { Discount, Prisma, Product } from '../generated/prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DiscountType } from './enums/discount-type.enum';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../test/helpers/audit.helper';
import { Decimal } from '@prisma/client/runtime/client';

const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockDiscountRepository = {
  create: jest.fn(),
  update: jest.fn(),
  findById: jest.fn(),
  findAll: jest.fn(),
  delete: jest.fn(),
  findProductById: jest.fn(),
  findProductWithDiscounts: jest.fn(),
  findVariantById: jest.fn(),
  findCategoryDiscounts: jest.fn(),
  findVariantDiscounts: jest.fn(),
  getInvalidIds: jest.fn(),
  findCartById: jest.fn(),
  updateCartItem: jest.fn(),
  findActiveDiscountsFor: jest.fn(),
  addItemsToDiscount: jest.fn(),
  removeItemsFromDiscount: jest.fn(),
};

const mockDiscount: Discount = {
  id: 'discount1',
  name: 'Summer Sale',
  description: '20% off',
  type: DiscountType.PERCENTAGE,
  value: new Prisma.Decimal(20),
  startDate: new Date('2025-06-01'),
  endDate: new Date('2025-06-30'),
  isActive: true,
  minimumPurchase: null,
  createdAt: new Date('2025-05-01'),
  updatedAt: new Date('2025-05-01'),
};

const mockProduct = {
  id: 'product1',
  name: 'T-Shirt',
  price: new Prisma.Decimal(100),
  description: null,
  sku: 'TSHIRT001',
  quantity: 10,
  images: [],
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  categoryId: 'category1',
  subcategoryId: null,
  brandId: null,
} as unknown as Product;

const mockCartItem = {
  id: 'cartItem1',
  cartId: 'cart1',
  productId: 'product1',
  variantId: null,
  quantity: 2,
  originalPrice: 100,
  discountedPrice: null,
  discountId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  product: mockProduct,
  variant: null,
};

const mockCart = {
  id: 'cart1',
  userId: 'user1',
  items: [mockCartItem],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockAuditService = createAuditServiceMock();

describe('DiscountService', () => {
  let service: DiscountService;
  let discountRepository: jest.Mocked<DiscountRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountService,
        { provide: DiscountRepository, useValue: mockDiscountRepository },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<DiscountService>(DiscountService);
    discountRepository = module.get<DiscountRepository>(DiscountRepository) as jest.Mocked<DiscountRepository>;
    jest.clearAllMocks();
  });

  describe('createDiscount', () => {
    const input: CreateDiscountInput = {
      name: 'Summer Sale',
      type: DiscountType.PERCENTAGE,
      value: new Decimal('20'),
      startDate: new Date('2025-06-01'),
      endDate: new Date('2025-06-30'),
      isActive: true,
      products: ['product1'],
      variants: [],
      categories: [],
    };

    it('should create a discount successfully', async () => {
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.create.mockResolvedValue(mockDiscount);

      const result = await service.createDiscount(input, 'admin1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: input.name,
          type: input.type,
          value: input.value,
          isActive: true,
          products: { connect: [{ id: 'product1' }] },
        }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
    });

    it('should throw BadRequestException for invalid product IDs', async () => {
      mockDiscountRepository.getInvalidIds.mockResolvedValue(['product1']);

      await expect(service.createDiscount(input, 'admin1')).rejects.toThrow(BadRequestException);
      expect(discountRepository.getInvalidIds).toHaveBeenCalledWith(['product1'], 'product');
    });

    it('should throw BadRequestException for endDate before startDate', async () => {
      const invalidInput = { ...input, endDate: new Date('2025-05-01') };

      await expect(service.createDiscount(invalidInput, 'admin1')).rejects.toThrow('End date must be after start date');
    });
  });

  describe('updateDiscount', () => {
    const input: UpdateDiscountInput = {
      id: 'discount1',
      name: 'Updated Sale',
      isActive: false,
    };

    it('should update a discount successfully', async () => {
      const updated = { ...mockDiscount, name: 'Updated Sale', isActive: false };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.update.mockResolvedValue(updated);

      const result = await service.updateDiscount(input.id, input, 'admin1');

      expect(result).toEqual(updated);
      expect(discountRepository.update).toHaveBeenCalledWith(
        input.id,
        expect.objectContaining({ name: input.name, isActive: false }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.updateDiscount(input.id, input, 'admin1')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for empty update', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      await expect(service.updateDiscount(input.id, { id: input.id }, 'admin1')).rejects.toThrow(
        'At least one field must be provided for update',
      );
    });
  });

  describe('findAllDiscounts', () => {
    it('should return all discounts from cache when cached', async () => {
      mockCacheManager.get.mockResolvedValue([mockDiscount]);

      const result = await service.findAllDiscounts();

      expect(result).toEqual([mockDiscount]);
      expect(discountRepository.findAll).not.toHaveBeenCalled();
    });

    it('should fetch from repository on cache miss and populate cache', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findAll.mockResolvedValue([mockDiscount]);

      const result = await service.findAllDiscounts();

      expect(result).toEqual([mockDiscount]);
      expect(discountRepository.findAll).toHaveBeenCalled();
      expect(mockCacheManager.set).toHaveBeenCalledWith('discount:all', [mockDiscount]);
    });
  });

  describe('findOneDiscount', () => {
    it('should return a discount from cache when cached', async () => {
      mockCacheManager.get.mockResolvedValue(mockDiscount);

      const result = await service.findOneDiscount('discount1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.findById).not.toHaveBeenCalled();
    });

    it('should fetch from repository on cache miss', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      const result = await service.findOneDiscount('discount1');

      expect(result).toEqual(mockDiscount);
      expect(mockCacheManager.set).toHaveBeenCalledWith('discount:discount1', mockDiscount);
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.findOneDiscount('discount2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteDiscount', () => {
    it('should delete a discount successfully', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.delete.mockResolvedValue(mockDiscount);

      const result = await service.deleteDiscount('discount1', 'admin1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.delete).toHaveBeenCalledWith('discount1', AUDIT_TX);
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.deleteDiscount('discount2', 'admin1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDiscountedPriceForProduct', () => {
    it('should calculate discounted price for a product', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({
        categoryId: 'category1',
        discounts: [mockDiscount],
      });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);

      const result = await service.getDiscountedPriceForProduct('product1');

      expect(result).toEqual({
        discountedPrice: new Decimal('80'),
        discountAmount: new Decimal('20'),
        discountId: 'discount1',
      });
    });

    it('should calculate discounted price for a variant', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findVariantById.mockResolvedValue({ price: new Prisma.Decimal(120) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({ categoryId: 'category1', discounts: [] });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);
      mockDiscountRepository.findVariantDiscounts.mockResolvedValue([mockDiscount]);

      const result = await service.getDiscountedPriceForProduct('product1', 'variant1');

      expect(result).toEqual({
        discountedPrice: new Decimal('96'),
        discountAmount: new Decimal('24'),
        discountId: 'discount1',
      });
    });

    it('should return original price if no discounts apply', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({ categoryId: 'category1', discounts: [] });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);

      const result = await service.getDiscountedPriceForProduct('product1');

      expect(result).toEqual({ discountedPrice: new Decimal('100'), discountAmount: new Decimal('0') });
    });

    it('should throw NotFoundException for non-existent product', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue(null);

      await expect(service.getDiscountedPriceForProduct('product2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('applyDiscountsToCart', () => {
    const targeting = (discount: Discount, productIds: string[], categoryIds: string[] = []) => ({
      ...discount,
      products: productIds.map((id) => ({ id })),
      categories: categoryIds.map((id) => ({ id })),
    });

    it('should apply discounts to cart items and compute totals', async () => {
      mockDiscountRepository.findCartById.mockResolvedValue(mockCart);
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([targeting(mockDiscount, ['product1'])]);
      mockDiscountRepository.updateCartItem.mockResolvedValue({
        ...mockCartItem,
        discountedPrice: 80,
        discountId: 'discount1',
      });

      const result = await service.applyDiscountsToCart('cart1');

      expect(result).toEqual({
        ...mockCart,
        items: [{ ...mockCartItem, discountedPrice: 80, discountId: 'discount1' }],
        total: new Decimal('200'),
        discountTotal: new Decimal('40'),
        finalTotal: new Decimal('160'),
      });
      expect(discountRepository.findActiveDiscountsFor).toHaveBeenCalledWith(['product1'], ['category1']);
      expect(discountRepository.updateCartItem).toHaveBeenCalledWith('cartItem1', {
        originalPrice: new Prisma.Decimal(100),
        discountedPrice: new Prisma.Decimal(80),
        discountId: 'discount1',
      });
    });

    it('applies a category discount when it saves more than the product discount', async () => {
      const flatTen = { ...mockDiscount, id: 'flat10', type: DiscountType.FLAT, value: new Prisma.Decimal(10) };
      mockDiscountRepository.findCartById.mockResolvedValue(mockCart);
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([
        targeting(flatTen, ['product1']),
        targeting(mockDiscount, [], ['category1']),
      ]);
      mockDiscountRepository.updateCartItem.mockResolvedValue(mockCartItem);

      const result = await service.applyDiscountsToCart('cart1');

      expect(result.discountTotal).toEqual(new Decimal('40'));
      expect(discountRepository.updateCartItem).toHaveBeenCalledWith(
        'cartItem1',
        expect.objectContaining({ discountId: 'discount1' }),
      );
    });

    it('should throw NotFoundException for non-existent cart', async () => {
      mockDiscountRepository.findCartById.mockResolvedValue(null);

      await expect(service.applyDiscountsToCart('cart2')).rejects.toThrow(NotFoundException);
    });

    it('does not apply a discount whose minimum purchase the cart does not reach, instead of failing the cart', async () => {
      const discountWithMinPurchase = { ...mockDiscount, minimumPurchase: new Prisma.Decimal(300) };
      mockDiscountRepository.findCartById.mockResolvedValue(mockCart);
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([
        targeting(discountWithMinPurchase, ['product1']),
      ]);
      mockDiscountRepository.updateCartItem.mockResolvedValue(mockCartItem);

      const result = await service.applyDiscountsToCart('cart1');

      expect(result).toEqual(
        expect.objectContaining({
          total: new Decimal('200'),
          discountTotal: new Decimal('0'),
          finalTotal: new Decimal('200'),
        }),
      );
    });

    it('rejects a cart holding a product without a price', async () => {
      mockDiscountRepository.findCartById.mockResolvedValue({
        ...mockCart,
        items: [{ ...mockCartItem, product: { ...mockProduct, price: null } }],
      });
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([]);

      await expect(service.applyDiscountsToCart('cart1')).rejects.toThrow(BadRequestException);
      expect(discountRepository.updateCartItem).not.toHaveBeenCalled();
    });
  });

  describe('validateDiscountInput (private)', () => {
    it('should throw BadRequestException for negative discount value', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: new Decimal('-10'),
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow('Discount value must be non-negative');
    });

    it('should throw BadRequestException for percentage > 100', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: new Decimal('150'),
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });
  });

  describe('addToDiscount', () => {
    it('should add products to a discount successfully', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(updatedDiscount);

      const result = await service.addToDiscount(
        {
          discountId: 'discount1',
          products: ['product1'],
          variants: [],
          categories: [],
        },
        'admin1',
      );

      expect(result).toEqual(updatedDiscount);
      expect(mockDiscountRepository.addItemsToDiscount).toHaveBeenCalledWith(
        'discount1',
        expect.objectContaining({ products: { connect: [{ id: 'product1' }] } }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException if discount not found', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.addToDiscount({ discountId: 'nonexistent', products: ['p1'] }, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for invalid product IDs', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue(['invalid-id']);

      await expect(
        service.addToDiscount({ discountId: 'discount1', products: ['invalid-id'] }, 'admin1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not call addItemsToDiscount with empty products/variants/categories', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(updatedDiscount);

      await service.addToDiscount({ discountId: 'discount1' }, 'admin1');

      expect(mockDiscountRepository.addItemsToDiscount).toHaveBeenCalledWith(
        'discount1',
        {
          products: undefined,
          variants: undefined,
          categories: undefined,
        },
        AUDIT_TX,
      );
    });
  });

  describe('removeFromDiscount', () => {
    it('should remove products from a discount successfully', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(updatedDiscount);

      const result = await service.removeFromDiscount(
        {
          discountId: 'discount1',
          products: ['product1'],
          variants: [],
          categories: [],
        },
        'admin1',
      );

      expect(result).toEqual(updatedDiscount);
      expect(mockDiscountRepository.removeItemsFromDiscount).toHaveBeenCalledWith(
        'discount1',
        expect.objectContaining({ products: { disconnect: [{ id: 'product1' }] } }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
    });

    it('should throw NotFoundException if discount not found', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(
        service.removeFromDiscount({ discountId: 'nonexistent', products: ['p1'] }, 'admin1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle empty arrays by passing undefined to repository', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(updatedDiscount);

      await service.removeFromDiscount({ discountId: 'discount1' }, 'admin1');

      expect(mockDiscountRepository.removeItemsFromDiscount).toHaveBeenCalledWith(
        'discount1',
        {
          products: undefined,
          variants: undefined,
          categories: undefined,
        },
        AUDIT_TX,
      );
    });
  });

  describe('audit trail', () => {
    beforeEach(() => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.create.mockResolvedValue(mockDiscount);
      mockDiscountRepository.update.mockImplementation(async (_id, data) => ({
        ...mockDiscount,
        ...withoutUndefined(data),
      }));
      mockDiscountRepository.delete.mockResolvedValue(mockDiscount);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(mockDiscount);
    });

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createDiscount',
        () =>
          service.createDiscount(
            {
              name: mockDiscount.name,
              type: DiscountType.PERCENTAGE,
              value: new Decimal('20'),
              startDate: new Date('2025-06-01'),
              endDate: new Date('2025-06-30'),
              isActive: true,
              products: ['product1'],
              variants: [],
              categories: [],
            },
            'admin1',
          ),
        {
          action: 'CREATE',
          details: {
            after: expect.objectContaining({ name: mockDiscount.name }),
            products: ['product1'],
            variants: [],
            categories: [],
          },
        },
      ],
      [
        'updateDiscount',
        () => service.updateDiscount('discount1', { id: 'discount1', isActive: !mockDiscount.isActive }, 'admin1'),
        {
          action: 'UPDATE',
          details: { changes: { isActive: { from: mockDiscount.isActive, to: !mockDiscount.isActive } } },
        },
      ],
      [
        'addToDiscount',
        () => service.addToDiscount({ discountId: 'discount1', products: ['product1'] }, 'admin1'),
        { action: 'UPDATE', details: { add: { products: ['product1'] } } },
      ],
      [
        'removeFromDiscount',
        () => service.removeFromDiscount({ discountId: 'discount1', categories: ['category1'] }, 'admin1'),
        { action: 'UPDATE', details: { remove: { categories: ['category1'] } } },
      ],
      [
        'deleteDiscount',
        () => service.deleteDiscount('discount1', 'admin1'),
        { action: 'DELETE', details: { before: expect.objectContaining({ name: mockDiscount.name }) } },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        { entity: 'Discount', entityId: mockDiscount.id, userId: 'admin1', ...expected },
        AUDIT_TX,
      );
    });
  });
});
