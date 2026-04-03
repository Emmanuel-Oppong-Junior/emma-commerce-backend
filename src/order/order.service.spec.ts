import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from '../cart/cart.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './order.service';
import { OrdersRepository } from './order.repository';
import { AuditService } from '../commons/audit.service';
import { CouponsService } from '../coupons/coupons.service';
import { TaxService } from '../tax/tax.service';
import { InventoryService } from '../inventory/inventory.service';
import { NotificationsService } from '../notifications/notifications.service';
import { Decimal } from '@prisma/client/runtime/library';

const mockAuditService = { log: jest.fn() };
const mockCouponsService = { validateCoupon: jest.fn(), recordUsage: jest.fn() };
const mockTaxService = { getRateForCountry: jest.fn().mockResolvedValue(new Decimal('0.1')) };
const mockInventoryService = { logInventoryChange: jest.fn().mockResolvedValue(undefined) };
const mockNotificationsService = { sendOrderConfirmation: jest.fn(), sendOrderStatusUpdate: jest.fn() };

const mockOrdersRepository = {
  findById: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn(),
  softDelete: jest.fn(),
  findAddressForUser: jest.fn(),
  findUserById: jest.fn(),
  updateProductStock: jest.fn(),
  decrementProductStock: jest.fn(),
  findProductById: jest.fn(),
  findProduct: jest.fn(),
  clearCartItems: jest.fn(),
  runTransaction: jest.fn(),
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

describe('OrdersService', () => {
  let ordersService: OrdersService;
  let ordersRepository: jest.Mocked<OrdersRepository>;
  let cartService: jest.Mocked<typeof mockCartService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: mockOrdersRepository },
        { provide: CartService, useValue: mockCartService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: CouponsService, useValue: mockCouponsService },
        { provide: TaxService, useValue: mockTaxService },
        { provide: InventoryService, useValue: mockInventoryService },
        { provide: NotificationsService, useValue: mockNotificationsService },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    ordersRepository = module.get<OrdersRepository>(OrdersRepository) as jest.Mocked<OrdersRepository>;
    cartService = module.get(CartService);
    jest.resetAllMocks();

    // Default transaction mock: executes the callback with a stub tx
    mockOrdersRepository.runTransaction.mockImplementation(async (callback) => {
      const stubTx = {};
      return callback(stubTx as any);
    });
    // Default product stock operations return the product unchanged
    mockOrdersRepository.decrementProductStock.mockResolvedValue({ ...mockProduct, quantity: 98 });
    mockOrdersRepository.updateProductStock.mockResolvedValue(mockProduct);
    mockOrdersRepository.clearCartItems.mockResolvedValue(undefined);
  });

  describe('createOrderFromCart', () => {
    it('should create an order successfully', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        id: mockAddressId,
        userId: mockUserId,
        country: 'GH',
        street: '1 Main St',
        city: 'Accra',
        state: 'GA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findProductById.mockResolvedValue(mockProduct);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      const result = await ordersService.createOrderFromCart(mockUserId, mockAddressId);

      expect(cartService.getCartOrThrow).toHaveBeenCalledWith(mockUserId);
      expect(ordersRepository.create).toHaveBeenCalled();
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
      mockOrdersRepository.findAddressForUser.mockResolvedValue(null);

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        new NotFoundException(`Shipping address "${mockAddressId}" not found for user "${mockUserId}"`),
      );
    });

    it('should throw BadRequestException if user is inactive', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        id: mockAddressId,
        userId: mockUserId,
        country: 'GH',
        street: '1 Main St',
        city: 'Accra',
        state: 'GA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue({ ...mockUser, isActive: false });

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(
        new BadRequestException(`User "${mockUserId}" is not eligible to place an order`),
      );
    });

    it('should throw BadRequestException if stock is insufficient (pre-validation)', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue({
        ...mockCart,
        items: [{ ...mockCartItem, quantity: 101 }],
      });
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        id: mockAddressId,
        userId: mockUserId,
        country: 'GH',
        street: '1 Main St',
        city: 'Accra',
        state: 'GA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findProductById.mockResolvedValue(mockProduct);

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(BadRequestException);
    });

    it('should roll back if stock goes negative inside transaction (oversell prevention)', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        id: mockAddressId,
        userId: mockUserId,
        country: 'GH',
        street: '1 Main St',
        city: 'Accra',
        state: 'GA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findProductById.mockResolvedValue(mockProduct);
      mockOrdersRepository.decrementProductStock.mockResolvedValue({ ...mockProduct, quantity: -1 });

      await expect(ordersService.createOrderFromCart(mockUserId, mockAddressId)).rejects.toThrow(BadRequestException);
    });
  });

  describe('getOrder', () => {
    it("should retrieve a user's order", async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);

      const result = await ordersService.getOrder(mockUserId, 'order1');

      expect(result).toEqual(mockOrder);
    });

    it('should throw NotFoundException if order belongs to a different user', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, userId: 'other-user' });

      await expect(ordersService.getOrder(mockUserId, 'order1')).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockOrdersRepository.findById.mockResolvedValue(null);

      await expect(ordersService.getOrder(mockUserId, 'order1')).rejects.toThrow(
        new NotFoundException(`Order "order1" not found`),
      );
    });
  });

  describe('getUserOrders', () => {
    it('should retrieve all user orders', async () => {
      mockOrdersRepository.findByUser.mockResolvedValue([mockOrder]);

      const result = await ordersService.getUserOrders(mockUserId);

      expect(ordersRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual([mockOrder]);
    });
  });

  describe('getOrders (admin)', () => {
    it('should retrieve all non-deleted orders', async () => {
      mockOrdersRepository.findAll.mockResolvedValue([mockOrder]);

      await ordersService.getOrders();

      expect(ordersRepository.findAll).toHaveBeenCalled();
    });
  });

  describe('updateOrderStatus', () => {
    it('should update order status and write audit log', async () => {
      const updatedOrder = { ...mockOrder, status: 'SHIPPED' as OrderStatus };
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.updateStatus.mockResolvedValue(updatedOrder);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1');

      expect(ordersRepository.updateStatus).toHaveBeenCalledWith('order1', OrderStatus.SHIPPED);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', entityId: 'order1', action: 'STATUS_CHANGE', userId: 'admin1' }),
      );
      expect(result.status).toBe('SHIPPED');
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockOrdersRepository.findById.mockResolvedValue(null);

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED)).rejects.toThrow(NotFoundException);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order and restore stock', async () => {
      const cancelledOrder = { ...mockOrder, status: 'CANCELLED' as OrderStatus };
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.updateStatus.mockResolvedValue(cancelledOrder);

      const result = await ordersService.cancelOrder(mockUserId, 'order1');

      expect(ordersRepository.updateProductStock).toHaveBeenCalledWith(expect.anything(), 'prod1', 2);
      expect(result.status).toBe('CANCELLED');
    });

    it('should throw BadRequestException if order is already shipped', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: 'SHIPPED' as OrderStatus });

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(BadRequestException);
    });

    it("should not allow cancelling another user's order", async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, userId: 'other-user' });

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteOrder (soft delete)', () => {
    it('should soft-delete an order and restore stock', async () => {
      const deletedOrder = { ...mockOrder, deleted: true, deletedAt: new Date() };
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.softDelete.mockResolvedValue(deletedOrder);
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.deleteOrder('order1', 'admin1');

      expect(ordersRepository.softDelete).toHaveBeenCalledWith('order1');
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', action: 'DELETE', userId: 'admin1' }),
      );
      expect(result.deleted).toBe(true);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockOrdersRepository.findById.mockResolvedValue(null);

      await expect(ordersService.deleteOrder('order1')).rejects.toThrow(NotFoundException);
    });
  });
});
