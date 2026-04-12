import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { OrdersRepository } from './order.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Address, FulfillmentType, Order, OrderItem, Prisma, Product, User } from '@prisma/client';

const fixedDate = new Date('2025-01-01T00:00:00.000Z');

const mockOrder = {
  id: 'order1',
  userId: 'user1',
  status: 'PENDING',
  totalAmount: new Prisma.Decimal(100),
  shippingAddressId: 'addr1',
  trackingNumber: null,
  carrier: null,
  deleted: false,
  deletedAt: null,
  createdAt: fixedDate,
  updatedAt: fixedDate,
  items: [],
} as unknown as Order & { items: OrderItem[] };

const mockPrismaOrder = {
  findUnique: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const mockPrismaAddress = { findUnique: jest.fn(), findFirst: jest.fn() };
const mockPrismaUser = { findUnique: jest.fn() };
const mockPrismaProduct = { findUnique: jest.fn() };

const mockPrisma = {
  order: mockPrismaOrder,
  address: mockPrismaAddress,
  user: mockPrismaUser,
  product: mockPrismaProduct,
  $transaction: jest.fn(),
};

describe('OrdersRepository', () => {
  let repository: OrdersRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [OrdersRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<OrdersRepository>(OrdersRepository);
    jest.clearAllMocks();
  });

  describe('findById', () => {
    it('should find an order by ID with default items include', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      const result = await repository.findById('order1');

      expect(result).toEqual(mockOrder);
      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'order1' }, include: { items: true } }),
      );
    });

    it('should use custom include when provided', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(mockOrder);

      await repository.findById('order1', { items: { include: { product: true } } });

      expect(mockPrismaOrder.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ include: { items: { include: { product: true } } } }),
      );
    });

    it('should return null if not found', async () => {
      mockPrismaOrder.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByUser', () => {
    it('should return all orders for a user', async () => {
      mockPrismaOrder.findMany.mockResolvedValue([mockOrder]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockOrder]);
      expect(mockPrismaOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user1', deleted: false } }),
      );
    });
  });

  describe('findAll', () => {
    it('should return all non-deleted orders', async () => {
      mockPrismaOrder.findMany.mockResolvedValue([mockOrder]);

      const result = await repository.findAll();

      expect(result).toEqual([mockOrder]);
      expect(mockPrismaOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { deleted: false } }));
    });
  });

  describe('create', () => {
    it('should create an order via transaction', async () => {
      const mockTx = { order: { create: jest.fn().mockResolvedValue(mockOrder) } };

      const result = await repository.create(mockTx as any, 'user1', {
        orderItems: [] as any,
        totalAmount: new Prisma.Decimal(100),
        fulfillmentType: FulfillmentType.DELIVERY,
        shippingAddressId: 'addr1',
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
      });

      expect(result).toEqual(mockOrder);
      expect(mockTx.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ userId: 'user1', shippingAddressId: 'addr1' }),
        }),
      );
    });
  });

  describe('findAddressById', () => {
    it('should find an address by ID', async () => {
      const mockAddress = { id: 'addr1', city: 'Accra' } as unknown as Address;
      mockPrismaAddress.findUnique.mockResolvedValue(mockAddress);

      const result = await repository.findAddressById('addr1');

      expect(result).toEqual(mockAddress);
    });

    it('should return null if not found', async () => {
      mockPrismaAddress.findUnique.mockResolvedValue(null);

      const result = await repository.findAddressById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('updateShipping', () => {
    it('should update shipping info', async () => {
      const updated = { ...mockOrder, trackingNumber: 'TRK123', carrier: 'DHL' };
      mockPrismaOrder.update.mockResolvedValue(updated);

      const result = await repository.updateShipping('order1', 'TRK123', 'DHL');

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaOrder.update.mockRejectedValue(prismaError);

      await expect(repository.updateShipping('nonexistent', 'TRK123')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaOrder.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.updateShipping('order1', 'TRK123')).rejects.toThrow('DB error');
    });
  });

  describe('updateStatus', () => {
    it('should update order status', async () => {
      const updated = { ...mockOrder, status: 'CONFIRMED' };
      mockPrismaOrder.update.mockResolvedValue(updated);

      const result = await repository.updateStatus('order1', 'CONFIRMED' as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaOrder.update.mockRejectedValue(prismaError);

      await expect(repository.updateStatus('nonexistent', 'CONFIRMED' as any)).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaOrder.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.updateStatus('order1', 'CONFIRMED' as any)).rejects.toThrow('DB error');
    });
  });

  describe('softDelete', () => {
    it('should soft delete an order', async () => {
      const deleted = { ...mockOrder, deleted: true, deletedAt: fixedDate };
      mockPrismaOrder.update.mockResolvedValue(deleted);

      const result = await repository.softDelete('order1');

      expect(result).toEqual(deleted);
      expect(mockPrismaOrder.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order1' },
          data: expect.objectContaining({ deleted: true }),
        }),
      );
    });
  });

  describe('findAddressForUser', () => {
    it('should find an address for a specific user', async () => {
      const mockAddress = { id: 'addr1', userId: 'user1' } as unknown as Address;
      mockPrismaAddress.findFirst.mockResolvedValue(mockAddress);

      const result = await repository.findAddressForUser('addr1', 'user1');

      expect(result).toEqual(mockAddress);
      expect(mockPrismaAddress.findFirst).toHaveBeenCalledWith({
        where: { id: 'addr1', userId: 'user1' },
      });
    });
  });

  describe('findUserById', () => {
    it('should find a user by ID', async () => {
      const mockUser = { id: 'user1', email: 'user@example.com' } as unknown as User;
      mockPrismaUser.findUnique.mockResolvedValue(mockUser);

      const result = await repository.findUserById('user1');

      expect(result).toEqual(mockUser);
    });
  });

  describe('updateProductStock', () => {
    it('should increment product quantity via transaction', async () => {
      const updatedProduct = { id: 'prod1', quantity: 15 } as unknown as Product;
      const mockTx = { product: { update: jest.fn().mockResolvedValue(updatedProduct) } };

      const result = await repository.updateProductStock(mockTx as any, 'prod1', 5);

      expect(result).toEqual(updatedProduct);
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: 'prod1' },
        data: { quantity: { increment: 5 } },
      });
    });
  });

  describe('decrementProductStock', () => {
    it('should decrement product quantity via transaction', async () => {
      const updatedProduct = { id: 'prod1', quantity: 8 } as unknown as Product;
      const mockTx = { product: { update: jest.fn().mockResolvedValue(updatedProduct) } };

      const result = await repository.decrementProductStock(mockTx as any, 'prod1', 2);

      expect(result).toEqual(updatedProduct);
      expect(mockTx.product.update).toHaveBeenCalledWith({
        where: { id: 'prod1' },
        data: { quantity: { decrement: 2 } },
      });
    });
  });

  describe('findProductById', () => {
    it('should find a product by ID', async () => {
      const mockProduct = { id: 'prod1', name: 'T-Shirt' } as unknown as Product;
      mockPrismaProduct.findUnique.mockResolvedValue(mockProduct);

      const result = await repository.findProductById('prod1');

      expect(result).toEqual(mockProduct);
    });
  });

  describe('findProduct', () => {
    it('should find a product via transaction', async () => {
      const mockProductData = { id: 'prod1', name: 'T-Shirt' } as unknown as Product;
      const mockTx = { product: { findUnique: jest.fn().mockResolvedValue(mockProductData) } };

      const result = await repository.findProduct(mockTx as any, 'prod1');

      expect(result).toEqual(mockProductData);
      expect(mockTx.product.findUnique).toHaveBeenCalledWith({ where: { id: 'prod1' } });
    });
  });

  describe('clearCartItems', () => {
    it('should clear all cart items via transaction', async () => {
      const mockTx = { cartItem: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) } };

      await repository.clearCartItems(mockTx as any, 'cart1');

      expect(mockTx.cartItem.deleteMany).toHaveBeenCalledWith({ where: { cartId: 'cart1' } });
    });
  });

  describe('runTransaction', () => {
    it('should delegate to prisma.$transaction', async () => {
      const fn = jest.fn().mockResolvedValue('result');
      mockPrisma.$transaction.mockImplementation((cb: any) => cb({}));

      await repository.runTransaction(fn);

      expect(mockPrisma.$transaction).toHaveBeenCalledWith(fn);
    });
  });
});
