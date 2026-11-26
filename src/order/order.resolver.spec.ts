import { Test, TestingModule } from '@nestjs/testing';
import { AnalyticsCounters } from '../analytics/counters/analytics-counters';
import { OrdersResolver } from './order.resolver';
import { OrdersService } from './order.service';
import { CreateOrderInput } from './dto/create-order.input';
import { FulfillmentTypeEnum, OrderStatusEnum } from './enums/order.enum';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { UsersLoader } from '../users/loaders/users.loader';

describe('OrdersResolver', () => {
  let resolver: OrdersResolver;
  let ordersService: OrdersService;

  const mockOrdersService = {
    getOrder: jest.fn(),
    getUserOrders: jest.fn(),
    getOrders: jest.fn(),
    createOrderFromCart: jest.fn(),
    checkoutQuote: jest.fn(),
    cancelOrder: jest.fn(),
    deleteOrder: jest.fn(),
  };

  const mockUserId = 'user1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockOrder = {
    id: 'order1',
    userId: mockUserId,
    totalAmount: 44.978,
    status: OrderStatusEnum.PLACED,
    shippingAddressId: 'addr1',
    createdAt: fixedDate,
    updatedAt: fixedDate,
    items: [
      {
        id: 'item1',
        orderId: 'order1',
        productId: 'prod1',
        variantId: null,
        quantity: 2,
        priceAtOrder: 19.99,
        createdAt: fixedDate,
        updatedAt: fixedDate,
        product: {
          id: 'prod1',
          name: 'T-Shirt',
          price: 19.99,
          quantity: 98,
          isActive: true,
          categoryId: 'cat1',
          createdAt: fixedDate,
          updatedAt: fixedDate,
          images: [],
        },
      },
    ],
  };

  const mockCreateOrderInput: CreateOrderInput = {
    fulfillmentType: FulfillmentTypeEnum.DELIVERY,
    shippingAddressId: 'addr1',
    contactEmail: 'test@example.com',
    contactPhone: '+233244000000',
    quoteHash: 'a'.repeat(64),
  };

  const mockActiveUser = (id: string) => ({ id });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersResolver,
        { provide: OrdersService, useValue: mockOrdersService },
        { provide: UsersLoader, useValue: { loader: { load: jest.fn() } } },
        // checkoutQuote counts quotes through an interceptor (P8-A)
        { provide: AnalyticsCounters, useValue: { increment: jest.fn() } },
      ],
    })
      .overrideProvider(ActiveUser)
      .useValue(mockActiveUser)
      .compile();

    resolver = module.get<OrdersResolver>(OrdersResolver);
    ordersService = module.get<OrdersService>(OrdersService);
    jest.resetAllMocks();
  });

  describe('getOrder', () => {
    it('should retrieve a specific order for the user', async () => {
      mockOrdersService.getOrder.mockResolvedValue(mockOrder);

      const result = await resolver.getOrder(mockUserId, 'order1');

      expect(ordersService.getOrder).toHaveBeenCalledWith(mockUserId, 'order1');
      expect(result).toEqual(mockOrder);
    });
  });

  describe('getUserOrders', () => {
    it('should retrieve all orders for the user', async () => {
      mockOrdersService.getUserOrders.mockResolvedValue([mockOrder]);

      const result = await resolver.getUserOrders(mockUserId);

      expect(ordersService.getUserOrders).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual([mockOrder]);
    });
  });

  describe('getOrders', () => {
    it('should retrieve all orders for admin', async () => {
      mockOrdersService.getOrders.mockResolvedValue([mockOrder]);

      const result = await resolver.getOrders();

      expect(ordersService.getOrders).toHaveBeenCalled();
      expect(result).toEqual([mockOrder]);
    });
  });

  describe('createOrder', () => {
    it('should create an order from the user’s cart', async () => {
      mockOrdersService.createOrderFromCart.mockResolvedValue(mockOrder);

      const result = await resolver.createOrder(mockUserId, mockCreateOrderInput, { ip: '41.66.1.2' } as never);

      expect(ordersService.createOrderFromCart).toHaveBeenCalledWith(mockUserId, {
        fulfillmentType: 'DELIVERY',
        shippingAddressId: 'addr1',
        pickupLocationId: undefined,
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
        couponCode: undefined,
        paymentMethod: undefined,
        quoteHash: 'a'.repeat(64),
        clientIp: '41.66.1.2',
      });
      expect(result).toEqual(mockOrder);
    });
  });

  describe('checkoutQuote', () => {
    it("prices the user's cart for the chosen fulfilment and coupon", async () => {
      const quote = { quoteHash: 'b'.repeat(64) };
      mockOrdersService.checkoutQuote.mockResolvedValue(quote);

      const result = await resolver.checkoutQuote(mockUserId, {
        fulfillmentType: FulfillmentTypeEnum.PICKUP,
        pickupLocationId: 'pickup1',
        couponCode: 'SAVE',
      });

      expect(ordersService.checkoutQuote).toHaveBeenCalledWith(mockUserId, {
        fulfillmentType: 'PICKUP',
        shippingAddressId: undefined,
        pickupLocationId: 'pickup1',
        couponCode: 'SAVE',
      });
      expect(result).toBe(quote);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order', async () => {
      const cancelledOrder = {
        ...mockOrder,
        status: OrderStatusEnum.CANCELLED,
      };
      mockOrdersService.cancelOrder.mockResolvedValue(cancelledOrder);

      const result = await resolver.cancelOrder(mockUserId, 'order1');

      expect(ordersService.cancelOrder).toHaveBeenCalledWith(mockUserId, 'order1', undefined);
      expect(result).toEqual(cancelledOrder);
    });
  });

  describe('deleteOrder', () => {
    it('should delete an order (admin only)', async () => {
      mockOrdersService.deleteOrder.mockResolvedValue(mockOrder);

      const result = await resolver.deleteOrder(mockUserId, 'order1');

      expect(ordersService.deleteOrder).toHaveBeenCalledWith('order1', mockUserId);
      expect(result).toEqual(mockOrder);
    });
  });

  describe('role-based access', () => {
    it('should allow USER role to access getOrder', async () => {
      mockOrdersService.getOrder.mockResolvedValue(mockOrder);

      const result = await resolver.getOrder(mockUserId, 'order1');

      expect(ordersService.getOrder).toHaveBeenCalled();
      expect(result).toEqual(mockOrder);
    });

    it('should allow ADMIN role to access getOrders', async () => {
      mockOrdersService.getOrders.mockResolvedValue([mockOrder]);

      const result = await resolver.getOrders();

      expect(ordersService.getOrders).toHaveBeenCalled();
      expect(result).toEqual([mockOrder]);
    });
  });
});
