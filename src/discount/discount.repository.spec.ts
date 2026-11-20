import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { DiscountRepository } from './discount.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Discount, Prisma } from '../generated/prisma/client';
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
  createdAt: new Date('2025-05-01'),
  updatedAt: new Date('2025-05-01'),
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

const mockPrisma = {
  discount: mockPrismaDiscount,
  product: mockPrismaProduct,
  variant: mockPrismaVariant,
  category: mockPrismaCategory,
  cart: mockPrismaCart,
  cartItem: mockPrismaCartItem,
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

  describe('findActiveDiscountsFor', () => {
    it('finds active, in-date discounts on the given products or categories, with only those targets', async () => {
      mockPrismaDiscount.findMany.mockResolvedValue([]);

      await repository.findActiveDiscountsFor(['p1'], ['c1']);

      const query = mockPrismaDiscount.findMany.mock.calls[0][0];
      expect(query.where).toEqual(
        expect.objectContaining({
          isActive: true,
          startDate: { lte: expect.any(Date) },
          endDate: { gte: expect.any(Date) },
          OR: [
            { id: { in: [] } },
            { products: { some: { id: { in: ['p1'] } } } },
            { categories: { some: { id: { in: ['c1'] } } } },
          ],
        }),
      );
      expect(query.include).toEqual({
        products: { where: { id: { in: ['p1'] } }, select: { id: true } },
        categories: { where: { id: { in: ['c1'] } }, select: { id: true } },
      });
    });

    it("also finds the variants' own discounts by id", async () => {
      mockPrismaDiscount.findMany.mockResolvedValue([mockDiscount]);

      const result = await repository.findActiveDiscountsFor(['p1'], [], ['discount1']);

      expect(result).toEqual([mockDiscount]);
      const query = mockPrismaDiscount.findMany.mock.calls[0][0];
      expect(query.where.OR).toContainEqual({ id: { in: ['discount1'] } });
    });
  });
});
