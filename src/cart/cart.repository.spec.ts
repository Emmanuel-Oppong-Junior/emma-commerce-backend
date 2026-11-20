import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CartRepository } from './cart.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Cart, CartItem, Prisma, Product } from '../generated/prisma/client';

const mockCart = {
  id: 'cart1',
  userId: 'user1',
  createdAt: new Date(),
  updatedAt: new Date(),
  items: [],
} as unknown as Cart & { items: CartItem[] };

const mockProduct = {
  id: 'prod1',
  name: 'T-Shirt',
  price: new Prisma.Decimal(50),
  quantity: 10,
  isActive: true,
} as unknown as Product;

const mockCartItem = {
  id: 'ci1',
  cartId: 'cart1',
  productId: 'prod1',
  quantity: 2,
  originalPrice: new Prisma.Decimal(50),
  discountedPrice: null,
  discountId: null,
  variantId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as CartItem;

const mockPrismaCart = { findUnique: jest.fn(), create: jest.fn() };
const mockPrismaProduct = { findUnique: jest.fn() };
const mockPrismaVariant = { count: jest.fn() };
const mockPrismaCartItem = {
  findFirst: jest.fn(),
  upsert: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
};

const mockPrisma = {
  cart: mockPrismaCart,
  product: mockPrismaProduct,
  variant: mockPrismaVariant,
  cartItem: mockPrismaCartItem,
};

describe('CartRepository', () => {
  let repository: CartRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CartRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<CartRepository>(CartRepository);
    jest.clearAllMocks();
  });

  describe('findByUser', () => {
    it('should return cart with items for a user', async () => {
      mockPrismaCart.findUnique.mockResolvedValue(mockCart);

      const result = await repository.findByUser('user1');

      expect(result).toEqual(mockCart);
      expect(mockPrismaCart.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user1' } }));
    });

    it('should return null if no cart found', async () => {
      mockPrismaCart.findUnique.mockResolvedValue(null);

      const result = await repository.findByUser('user1');

      expect(result).toBeNull();
    });
  });

  describe('findOrCreate', () => {
    it('should return existing cart', async () => {
      mockPrismaCart.findUnique.mockResolvedValue(mockCart);

      const result = await repository.findOrCreate('user1');

      expect(result).toEqual(mockCart);
      expect(mockPrismaCart.create).not.toHaveBeenCalled();
    });

    it('should create a new cart if none exists', async () => {
      mockPrismaCart.findUnique.mockResolvedValue(null);
      mockPrismaCart.create.mockResolvedValue(mockCart);

      const result = await repository.findOrCreate('user1');

      expect(result).toEqual(mockCart);
      expect(mockPrismaCart.create).toHaveBeenCalledWith({ data: { userId: 'user1' } });
    });
  });

  describe('findProductById', () => {
    it('should return product by ID', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(mockProduct);

      const result = await repository.findProductById('prod1');

      expect(result).toEqual(mockProduct);
    });

    it('should return null if product not found', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(null);

      const result = await repository.findProductById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('countVariants', () => {
    it("counts the product's variants", async () => {
      mockPrismaVariant.count.mockResolvedValue(2);

      const result = await repository.countVariants('prod1');

      expect(result).toBe(2);
      expect(mockPrismaVariant.count).toHaveBeenCalledWith({ where: { productId: 'prod1', optionsKey: { not: '' } } });
    });
  });

  describe('findCartItem', () => {
    it('should return cart item by cartId and productId', async () => {
      mockPrismaCartItem.findFirst.mockResolvedValue({ id: 'ci1', quantity: 2 });

      const result = await repository.findCartItem('cart1', 'prod1');

      expect(result).toEqual({ id: 'ci1', quantity: 2 });
    });

    it('should return null if no item found', async () => {
      mockPrismaCartItem.findFirst.mockResolvedValue(null);

      const result = await repository.findCartItem('cart1', 'prod1');

      expect(result).toBeNull();
    });
  });

  describe('upsertCartItem', () => {
    it('should upsert a cart item', async () => {
      mockPrismaCartItem.upsert.mockResolvedValue(undefined);

      await repository.upsertCartItem('ci1', 'cart1', 'prod1', new Prisma.Decimal(50), 3, 1);

      expect(mockPrismaCartItem.upsert).toHaveBeenCalledWith({
        where: { id: 'ci1' },
        update: { quantity: 3, originalPrice: new Prisma.Decimal(50) },
        create: { cartId: 'cart1', productId: 'prod1', quantity: 1, originalPrice: new Prisma.Decimal(50) },
      });
    });

    it('should use empty string when no existing item ID', async () => {
      mockPrismaCartItem.upsert.mockResolvedValue(undefined);

      await repository.upsertCartItem(undefined, 'cart1', 'prod1', new Prisma.Decimal(50), 1, 1);

      expect(mockPrismaCartItem.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '' } }));
    });
  });

  describe('updateCartItem', () => {
    it('should update a cart item', async () => {
      const updated = { ...mockCartItem, quantity: 5 };
      mockPrismaCartItem.update.mockResolvedValue(updated);

      const result = await repository.updateCartItem('ci1', { quantity: 5 });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaCartItem.update.mockRejectedValue(prismaError);

      await expect(repository.updateCartItem('nonexistent', { quantity: 5 })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaCartItem.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.updateCartItem('ci1', { quantity: 5 })).rejects.toThrow('DB error');
    });
  });

  describe('deleteCartItem', () => {
    it('should delete a cart item by ID', async () => {
      mockPrismaCartItem.delete.mockResolvedValue(undefined);

      await repository.deleteCartItem('ci1');

      expect(mockPrismaCartItem.delete).toHaveBeenCalledWith({ where: { id: 'ci1' } });
    });
  });

  describe('deleteAllCartItems', () => {
    it('should delete all items in a cart', async () => {
      mockPrismaCartItem.deleteMany.mockResolvedValue({ count: 3 });

      await repository.deleteAllCartItems('cart1');

      expect(mockPrismaCartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart1' } });
    });
  });
});
