import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DiscountRepository } from './discount.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Discount, Prisma } from '@prisma/client';
import { DiscountType } from './enums/discount-type.enum';

const mockDiscount: Discount = {
  id: 'discount1',
  name: 'Summer Sale',
  description: null,
  type: DiscountType.PERCENTAGE,
  value: new Prisma.Decimal(20),
  startDate: new Date('2025-06-01'),
  endDate: new Date('2025-06-30'),
  isActive: true,
  minimumPurchase: null,
};

const mockPrismaDiscount = {
  create: jest.fn(),
  update: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaProduct = {
  findUnique: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};

const mockPrismaVariant = { findUnique: jest.fn(), findMany: jest.fn() };
const mockPrismaCategory = { findMany: jest.fn() };
const mockPrismaCart = { findUnique: jest.fn() };
const mockPrismaCartItem = { update: jest.fn() };
const mockPrismaOrder = { findUnique: jest.fn(), update: jest.fn() };
const mockPrismaOrderItem = { update: jest.fn() };

const mockPrisma = {
  discount: mockPrismaDiscount,
  product: mockPrismaProduct,
  variant: mockPrismaVariant,
  category: mockPrismaCategory,
  cart: mockPrismaCart,
  cartItem: mockPrismaCartItem,
  order: mockPrismaOrder,
  orderItem: mockPrismaOrderItem,
};

describe('DiscountRepository', () => {
  let repository: DiscountRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DiscountRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<DiscountRepository>(DiscountRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a discount', async () => {
      mockPrismaDiscount.create.mockResolvedValue(mockDiscount);

      const result = await repository.create({ name: 'Summer Sale' } as any);

      expect(result).toEqual(mockDiscount);
    });
  });

  describe('update', () => {
    it('should update a discount', async () => {
      const updated = { ...mockDiscount, name: 'Updated' };
      mockPrismaDiscount.update.mockResolvedValue(updated);

      const result = await repository.update('discount1', { name: 'Updated' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaDiscount.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaDiscount.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('discount1', {})).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a discount by ID', async () => {
      mockPrismaDiscount.findUnique.mockResolvedValue(mockDiscount);

      const result = await repository.findById('discount1');

      expect(result).toEqual(mockDiscount);
    });

    it('should return null if not found', async () => {
      mockPrismaDiscount.findUnique.mockResolvedValue(null);

      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all discounts', async () => {
      mockPrismaDiscount.findMany.mockResolvedValue([mockDiscount]);

      const result = await repository.findAll();

      expect(result).toEqual([mockDiscount]);
    });
  });

  describe('delete', () => {
    it('should delete a discount', async () => {
      mockPrismaDiscount.delete.mockResolvedValue(mockDiscount);

      const result = await repository.delete('discount1');

      expect(result).toEqual(mockDiscount);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaDiscount.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaDiscount.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('discount1')).rejects.toThrow('DB error');
    });
  });

  describe('addItemsToDiscount', () => {
    it('should connect items to a discount', async () => {
      const updated = { ...mockDiscount };
      mockPrismaDiscount.update.mockResolvedValue(updated);

      const result = await repository.addItemsToDiscount('discount1', {
        products: { connect: [{ id: 'prod1' }] },
      });

      expect(result).toEqual(updated);
      expect(mockPrismaDiscount.update).toHaveBeenCalledWith({
        where: { id: 'discount1' },
        data: { products: { connect: [{ id: 'prod1' }] } },
      });
    });
  });

  describe('removeItemsFromDiscount', () => {
    it('should disconnect items from a discount', async () => {
      const updated = { ...mockDiscount };
      mockPrismaDiscount.update.mockResolvedValue(updated);

      const result = await repository.removeItemsFromDiscount('discount1', {
        products: { disconnect: [{ id: 'prod1' }] },
      });

      expect(result).toEqual(updated);
    });
  });

  describe('findProductById', () => {
    it('should find a product by ID with select', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue({ price: 100 });

      const result = await repository.findProductById('prod1', { price: true });

      expect(result).toEqual({ price: 100 });
    });
  });

  describe('findProductWithDiscounts', () => {
    it('should return product with active discounts', async () => {
      const productWithDiscounts = { categoryId: 'cat1', discounts: [mockDiscount] };
      mockPrismaProduct.findUnique.mockResolvedValue(productWithDiscounts);

      const result = await repository.findProductWithDiscounts('prod1');

      expect(result).toEqual(productWithDiscounts);
    });
  });

  describe('findVariantById', () => {
    it('should find a variant by ID with select', async () => {
      mockPrismaVariant.findUnique.mockResolvedValue({ price: 50 });

      const result = await repository.findVariantById('var1', { price: true });

      expect(result).toEqual({ price: 50 });
    });
  });

  describe('findCategoryDiscounts', () => {
    it('should return active discounts for a category', async () => {
      mockPrismaDiscount.findMany.mockResolvedValue([mockDiscount]);

      const result = await repository.findCategoryDiscounts('cat1');

      expect(result).toEqual([mockDiscount]);
    });
  });

  describe('findVariantDiscounts', () => {
    it('should return active discounts for a variant', async () => {
      mockPrismaDiscount.findMany.mockResolvedValue([mockDiscount]);

      const result = await repository.findVariantDiscounts('var1');

      expect(result).toEqual([mockDiscount]);
    });
  });

  describe('getInvalidIds', () => {
    it('should return empty array if all IDs are valid', async () => {
      mockPrismaProduct.count.mockResolvedValue(2);

      const result = await repository.getInvalidIds(['prod1', 'prod2'], 'product');

      expect(result).toEqual([]);
    });

    it('should return invalid IDs when count does not match', async () => {
      mockPrismaProduct.count.mockResolvedValue(1);
      mockPrismaProduct.findMany.mockResolvedValue([{ id: 'prod1' }]);

      const result = await repository.getInvalidIds(['prod1', 'invalid'], 'product');

      expect(result).toEqual(['invalid']);
    });
  });

  describe('updateCartItem', () => {
    it('should update a cart item', async () => {
      const cartItem = { id: 'ci1', discountedPrice: 80 };
      mockPrismaCartItem.update.mockResolvedValue(cartItem);

      const result = await repository.updateCartItem('ci1', { discountedPrice: 80 } as any);

      expect(result).toEqual(cartItem);
    });
  });

  describe('updateOrderItem', () => {
    it('should update an order item', async () => {
      const orderItem = { id: 'oi1', discountAmount: 20 };
      mockPrismaOrderItem.update.mockResolvedValue(orderItem);

      const result = await repository.updateOrderItem('oi1', { discountAmount: 20 } as any);

      expect(result).toEqual(orderItem);
    });
  });

  describe('updateOrderWithDiscount', () => {
    it('should update order with discount totals', async () => {
      const updatedOrder = { id: 'order1', totalAmount: 180, discountTotal: 20 };
      mockPrismaOrder.update.mockResolvedValue(updatedOrder);

      const result = await repository.updateOrderWithDiscount('order1', 180, 20);

      expect(result).toEqual(updatedOrder);
      expect(mockPrismaOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order1' },
          data: expect.objectContaining({ totalAmount: 180, discountTotal: 20 }),
        }),
      );
    });
  });

  describe('findCartById', () => {
    it('should return a cart with items', async () => {
      const mockCart = { id: 'cart1', items: [] };
      mockPrismaCart.findUnique.mockResolvedValue(mockCart);

      const result = await repository.findCartById('cart1');

      expect(result).toEqual(mockCart);
      expect(mockPrismaCart.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'cart1' } }));
    });

    it('should return null if cart not found', async () => {
      mockPrismaCart.findUnique.mockResolvedValue(null);

      const result = await repository.findCartById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findOrderById', () => {
    it('should return an order with items', async () => {
      const mockOrder = { id: 'order1', items: [] };
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      const result = await repository.findOrderById('order1');

      expect(result).toEqual(mockOrder);
      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'order1' } }));
    });

    it('should return null if order not found', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(null);

      const result = await repository.findOrderById('nonexistent');

      expect(result).toBeNull();
    });
  });
});
