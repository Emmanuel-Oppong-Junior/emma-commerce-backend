import { Test, TestingModule } from '@nestjs/testing';
import { DiscountService } from './discount.service';
import { DiscountRepository } from './discount.repository';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { Discount, Prisma, Product } from '@prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DiscountType } from './enums/discount-type.enum';

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
  findOrderById: jest.fn(),
  updateOrderItem: jest.fn(),
  updateOrderWithDiscount: jest.fn(),
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

describe('DiscountService', () => {
  let service: DiscountService;
  let discountRepository: jest.Mocked<DiscountRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscountService, { provide: DiscountRepository, useValue: mockDiscountRepository }],
    }).compile();

    service = module.get<DiscountService>(DiscountService);
    discountRepository = module.get<DiscountRepository>(DiscountRepository) as jest.Mocked<DiscountRepository>;
    jest.clearAllMocks();
  });

  describe('createDiscount', () => {
    const input: CreateDiscountInput = {
      name: 'Summer Sale',
      type: DiscountType.PERCENTAGE,
      value: 20,
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

      const result = await service.createDiscount(input);

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: input.name,
          type: input.type,
          value: input.value,
          isActive: true,
          products: { connect: [{ id: 'product1' }] },
        }),
      );
    });

    it('should throw BadRequestException for invalid product IDs', async () => {
      mockDiscountRepository.getInvalidIds.mockResolvedValue(['product1']);

      await expect(service.createDiscount(input)).rejects.toThrow(BadRequestException);
      expect(discountRepository.getInvalidIds).toHaveBeenCalledWith(['product1'], 'product');
    });

    it('should throw BadRequestException for endDate before startDate', async () => {
      const invalidInput = { ...input, endDate: new Date('2025-05-01') };

      await expect(service.createDiscount(invalidInput)).rejects.toThrow('End date must be after start date');
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

      const result = await service.updateDiscount(input.id, input);

      expect(result).toEqual(updated);
      expect(discountRepository.update).toHaveBeenCalledWith(
        input.id,
        expect.objectContaining({ name: input.name, isActive: false }),
      );
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.updateDiscount(input.id, input)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for empty update', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      await expect(service.updateDiscount(input.id, { id: input.id })).rejects.toThrow(
        'At least one field must be provided for update',
      );
    });
  });

  describe('findAllDiscounts', () => {
    it('should return all discounts', async () => {
      mockDiscountRepository.findAll.mockResolvedValue([mockDiscount]);

      const result = await service.findAllDiscounts();

      expect(result).toEqual([mockDiscount]);
      expect(discountRepository.findAll).toHaveBeenCalled();
    });
  });

  describe('findOneDiscount', () => {
    it('should return a discount by ID', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      const result = await service.findOneDiscount('discount1');

      expect(result).toEqual(mockDiscount);
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.findOneDiscount('discount2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteDiscount', () => {
    it('should delete a discount successfully', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.delete.mockResolvedValue(mockDiscount);

      const result = await service.deleteDiscount('discount1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.delete).toHaveBeenCalledWith('discount1');
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.deleteDiscount('discount2')).rejects.toThrow(NotFoundException);
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

      expect(result).toEqual({ discountedPrice: 80, discountAmount: 20, discountId: 'discount1' });
    });

    it('should calculate discounted price for a variant', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findVariantById.mockResolvedValue({ price: new Prisma.Decimal(120) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({ categoryId: 'category1', discounts: [] });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);
      mockDiscountRepository.findVariantDiscounts.mockResolvedValue([mockDiscount]);

      const result = await service.getDiscountedPriceForProduct('product1', 'variant1');

      expect(result).toEqual({ discountedPrice: 96, discountAmount: 24, discountId: 'discount1' });
    });

    it('should return original price if no discounts apply', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({ categoryId: 'category1', discounts: [] });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);

      const result = await service.getDiscountedPriceForProduct('product1');

      expect(result).toEqual({ discountedPrice: 100, discountAmount: 0 });
    });

    it('should throw NotFoundException for non-existent product', async () => {
      mockDiscountRepository.findProductById.mockResolvedValue(null);

      await expect(service.getDiscountedPriceForProduct('product2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('applyDiscountsToCart', () => {
    it('should apply discounts to cart items and compute totals', async () => {
      mockDiscountRepository.findCartById.mockResolvedValue(mockCart);
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({
        categoryId: 'category1',
        discounts: [mockDiscount],
      });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);
      mockDiscountRepository.updateCartItem.mockResolvedValue({
        ...mockCartItem,
        discountedPrice: 80,
        discountId: 'discount1',
      });

      const result = await service.applyDiscountsToCart('cart1');

      expect(result).toEqual({
        ...mockCart,
        items: [{ ...mockCartItem, discountedPrice: 80, discountId: 'discount1' }],
        total: 200,
        discountTotal: 40,
        finalTotal: 160,
      });
      expect(discountRepository.updateCartItem).toHaveBeenCalled();
    });

    it('should throw NotFoundException for non-existent cart', async () => {
      mockDiscountRepository.findCartById.mockResolvedValue(null);

      await expect(service.applyDiscountsToCart('cart2')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for minimum purchase not met', async () => {
      const discountWithMinPurchase = { ...mockDiscount, minimumPurchase: new Prisma.Decimal(300) };
      mockDiscountRepository.findCartById.mockResolvedValue(mockCart);
      mockDiscountRepository.findProductById.mockResolvedValue({ price: new Prisma.Decimal(100) });
      mockDiscountRepository.findProductWithDiscounts.mockResolvedValue({
        categoryId: 'category1',
        discounts: [discountWithMinPurchase],
      });
      mockDiscountRepository.findCategoryDiscounts.mockResolvedValue([]);
      mockDiscountRepository.updateCartItem.mockResolvedValue({
        ...mockCartItem,
        discountedPrice: 80,
        discountId: 'discount1',
      });

      await expect(service.applyDiscountsToCart('cart1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('finalizeDiscountsForOrder', () => {
    it('should throw NotFoundException for non-existent order', async () => {
      mockDiscountRepository.findOrderById.mockResolvedValue(null);

      await expect(service.finalizeDiscountsForOrder('order2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('validateDiscountInput (private)', () => {
    it('should throw BadRequestException for negative discount value', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: -10,
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow('Discount value must be non-negative');
    });

    it('should throw BadRequestException for percentage > 100', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: 150,
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });
  });

  describe('selectBestDiscount (private)', () => {
    it('should select the highest-value discount', () => {
      const discounts = [
        { ...mockDiscount, id: 'd1', value: new Prisma.Decimal(10) },
        { ...mockDiscount, id: 'd2', value: new Prisma.Decimal(20) },
      ] as Discount[];

      const result = service['selectBestDiscount'](discounts);

      expect(result?.id).toBe('d2');
    });

    it('should prefer percentage discount for equal values', () => {
      const discounts = [
        { ...mockDiscount, id: 'd1', type: DiscountType.FLAT, value: new Prisma.Decimal(20) },
        { ...mockDiscount, id: 'd2', type: DiscountType.PERCENTAGE, value: new Prisma.Decimal(20) },
      ] as Discount[];

      const result = service['selectBestDiscount'](discounts);

      expect(result?.id).toBe('d2');
    });

    it('should return null for empty discounts', () => {
      const result = service['selectBestDiscount']([]);

      expect(result).toBeNull();
    });
  });

  describe('calculateDiscountAmount (private)', () => {
    it('should calculate percentage discount', () => {
      const result = service['calculateDiscountAmount'](100, {
        ...mockDiscount,
        type: DiscountType.PERCENTAGE,
        value: new Prisma.Decimal(20),
      });

      expect(result).toBe(20);
    });

    it('should calculate fixed amount discount', () => {
      const result = service['calculateDiscountAmount'](100, {
        ...mockDiscount,
        type: DiscountType.FLAT,
        value: new Prisma.Decimal(15),
      });

      expect(result).toBe(15);
    });
  });
});
