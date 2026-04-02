import { Test, TestingModule } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './order.service';
import { AuditService } from '../commons/audit.service';

describe('OrdersService', () => {
  let ordersService: OrdersService;
  let prismaService: PrismaService;
  let cartService: CartService;

  const mockAuditService = { log: jest.fn() };

  const mockPrismaService = {
    order: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    address: {
      findFirst: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
    },
    cartItem: {
      deleteMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  const mockCartService = {
    getCartOrThrow: jest.fn(),
  };

  const mockUserId = 'user1';
  const mockAddressId = 'addr1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockProduct = {
    id: 'prod1',
    name: 'T-Shirt',
    price: 19.99,
    quantity: 100,
    isActive: true,
    categoryId: 'cat1',
    createdAt: fixedDate,
    updatedAt: fixedDate,
    images: [],
  };
  const mockCartItem = {
    id: 'item1',
    cartId: 'cart1',
    productId: 'prod1',
    quantity: 2,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
  const mockCart = {
    id: 'cart1',
    userId: mockUserId,
    items: [{ ...mockCartItem, product: mockProduct }],
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
  const mockOrderItem = {
    id: 'orderItem1',
    orderId: 'order1',
    productId: 'prod1',
    variantId: null,
    quantity: 2,
    priceAtOrder: 19.99,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
  const mockOrder = {
    id: 'order1',
    userId: mockUserId,
    totalAmount: 44.978,
    status: 'PENDING' as OrderStatus,
    shippingAddressId: mockAddressId,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    deleted: false,
    deletedAt: null,
    items: [{ ...mockOrderItem, product: mockProduct }],
  };
  const mockUser = {
    id: mockUserId,
    isActive: true,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    email: 'test@example.com',
    password: 'hashedPassword',
    role: 'USER',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CartService, useValue: mockCartService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    prismaService = module.get<PrismaService>(PrismaService);
    cartService = module.get<CartService>(CartService);
    jest.resetAllMocks();

    mockPrismaService.$transaction.mockImplementation(async (callback) => {
      return callback(mockPrismaService);
    });
  });

  describe('createOrderFromCart', () => {
    it('should create an order successfully', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPrismaService.address.findFirst.mockResolvedValue({ id: mockAddressId, userId: mockUserId });
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.product.findUnique.mockResolvedValue(mockProduct);
      // Stock re-check inside transaction: return product with quantity >= 0 after decrement
      mockPrismaService.product.update.mockResolvedValue({ ...mockProduct, quantity: 98 });
      mockPrismaService.order.create.mockResolvedValue(mockOrder);
      mockPrismaService.cartItem.deleteMany.mockResolvedValue({ count: 1 });

      const result = await ordersService.createOrderFromCart(mockUserId, mockAddressId);

      expect(cartService.getCartOrThrow).toHaveBeenCalledWith(mockUserId);
      expect(prismaService.order.create).toHaveBeenCalled();
      expect(result).toEqual(mockOrder);
    });

    it('should throw NotFoundException if cart is empty', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue({ ...mockCart, items: [] });

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        new NotFoundException(`Cart for user "${mockUserId}" is empty`),
      );
    });

    it('should throw NotFoundException if shipping address is invalid', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPrismaService.address.findFirst.mockResolvedValue(null);

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        new NotFoundException(`Shipping address "${mockAddressId}" not found for user "${mockUserId}"`),
      );
    });

    it('should throw BadRequestException if user is inactive', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPrismaService.address.findFirst.mockResolvedValue({ id: mockAddressId, userId: mockUserId });
      mockPrismaService.user.findUnique.mockResolvedValue({ ...mockUser, isActive: false });

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        new BadRequestException(`User "${mockUserId}" is not eligible to place an order`),
      );
    });

    it('should throw BadRequestException if stock is insufficient (pre-validation)', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue({
        ...mockCart,
        items: [{ ...mockCartItem, quantity: 101 }],
      });
      mockPrismaService.address.findFirst.mockResolvedValue({ id: mockAddressId, userId: mockUserId });
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.product.findUnique.mockResolvedValue(mockProduct);

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should roll back if stock goes negative inside transaction (oversell prevention)', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPrismaService.address.findFirst.mockResolvedValue({ id: mockAddressId, userId: mockUserId });
      mockPrismaService.user.findUnique.mockResolvedValue(mockUser);
      mockPrismaService.product.findUnique.mockResolvedValue(mockProduct);
      // Simulate concurrent purchase: decrement causes negative stock
      mockPrismaService.product.update.mockResolvedValue({ ...mockProduct, quantity: -1 });

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getOrder', () => {
    it('should retrieve a user\'s order', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(mockOrder);
      const result = await ordersService.getOrder(mockUserId, 'order1');
      expect(result).toEqual(mockOrder);
    });

    it('should throw NotFoundException if order belongs to a different user', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({ ...mockOrder, userId: 'other-user' });
      await expect(ordersService.getOrder(mockUserId, 'order1')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);
      await expect(ordersService.getOrder(mockUserId, 'order1')).rejects.toThrow(
        new NotFoundException(`Order "order1" not found`),
      );
    });
  });

  describe('getUserOrders', () => {
    it('should retrieve all user orders excluding soft-deleted', async () => {
      mockPrismaService.order.findMany.mockResolvedValue([mockOrder]);
      const result = await ordersService.getUserOrders(mockUserId);
      expect(prismaService.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: mockUserId, deleted: false } }),
      );
      expect(result).toEqual([mockOrder]);
    });
  });

  describe('getOrders (admin)', () => {
    it('should retrieve all non-deleted orders', async () => {
      mockPrismaService.order.findMany.mockResolvedValue([mockOrder]);
      await ordersService.getOrders();
      expect(prismaService.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deleted: false } }),
      );
    });
  });

  describe('updateOrderStatus', () => {
    it('should update order status and write audit log', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(mockOrder);
      mockPrismaService.order.update.mockResolvedValue({ ...mockOrder, status: 'SHIPPED' });
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1');

      expect(prismaService.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'order1' }, data: { status: 'SHIPPED' } }),
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'Order',
          entityId: 'order1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
        }),
      );
      expect(result.status).toBe('SHIPPED');
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);
      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order and restore stock', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(mockOrder);
      mockPrismaService.product.update.mockResolvedValue(mockProduct);
      mockPrismaService.order.update.mockResolvedValue({ ...mockOrder, status: 'CANCELLED' });

      const result = await ordersService.cancelOrder(mockUserId, 'order1');

      expect(prismaService.product.update).toHaveBeenCalledWith({
        where: { id: 'prod1' },
        data: { quantity: { increment: 2 } },
      });
      expect(result.status).toBe('CANCELLED');
    });

    it('should throw BadRequestException if order is already shipped', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({ ...mockOrder, status: 'SHIPPED' });
      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(BadRequestException);
    });

    it('should not allow cancelling another user\'s order', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue({ ...mockOrder, userId: 'other-user' });
      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteOrder (soft delete)', () => {
    it('should soft-delete an order and restore stock', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(mockOrder);
      mockPrismaService.product.update.mockResolvedValue(mockProduct);
      mockPrismaService.order.update.mockResolvedValue({ ...mockOrder, deleted: true, deletedAt: new Date() });
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.deleteOrder('order1', 'admin1');

      expect(prismaService.order.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deleted: true }) }),
      );
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', action: 'DELETE', userId: 'admin1' }),
      );
      expect(result.deleted).toBe(true);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockPrismaService.order.findUnique.mockResolvedValue(null);
      await expect(ordersService.deleteOrder('order1')).rejects.toThrow(NotFoundException);
    });
  });
});
