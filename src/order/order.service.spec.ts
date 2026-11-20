import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from '../cart/cart.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';
import { ORDER_EXPIRY_LOCK_KEY, OrdersService } from './order.service';
import { abandonedOrderWhere, OrdersRepository } from './order.repository';
import { AuditService } from '../commons/audit.service';
import { CouponsService } from '../coupons/coupons.service';
import { TaxService } from '../tax/tax.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { Decimal } from '@prisma/client/runtime/client';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { FulfillmentType } from '../generated/prisma/client';
import { ReturnsService } from '../returns/returns.service';
import { DiscountService } from '../discount/discount.service';
import { StoreService } from '../store/store.service';

const mockAuditService = { log: jest.fn() };
const mockCouponsService = { validateCoupon: jest.fn(), recordUsage: jest.fn(), releaseUsage: jest.fn() };
const mockTaxService = { getRateForCountry: jest.fn().mockResolvedValue(new Decimal('0.1')) };
const mockStockLedger = { reserve: jest.fn(), consumeOrder: jest.fn(), releaseOrder: jest.fn() };
const mockOutbox = { record: jest.fn() };
const mockShippingZonesService = { getFeeForCity: jest.fn().mockResolvedValue(new Decimal('5')) };
const mockPickupLocationsService = { findActiveById: jest.fn() };
const mockReturnsService = { createSystemReturnRequest: jest.fn() };
const mockDiscountService = { findActiveDiscountsByVariant: jest.fn() };
const mockStoreService = { getCurrency: jest.fn() };

const mockOrdersRepository = {
  findById: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  transitionStatus: jest.fn(),
  softDelete: jest.fn(),
  updateShipping: jest.fn(),
  findExpiredPendingOrders: jest.fn(),
  hasCompletedPayment: jest.fn(),
  findAddressForUser: jest.fn(),
  findUserById: jest.fn(),
  lockSellableVariant: jest.fn(),
  findVariant: jest.fn(),
  clearCartItems: jest.fn(),
  runTransaction: jest.fn(),
  runWithAdvisoryLock: jest.fn(),
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
  currency: 'GHS',
  isActive: true,
  status: 'PUBLISHED',
  categoryId: 'cat1',
  createdAt: fixedDate,
  updatedAt: fixedDate,
  images: [],
};
const mockVariant = {
  id: 'var1',
  productId: 'prod1',
  sku: 'TSHIRT-M',
  optionValues: { size: 'M' },
  price: new Decimal('19.99'),
  stockLevels: [{ onHand: 100, reserved: 0 }],
  isActive: true,
  discountId: null,
  product: mockProduct,
};
const mockCartItem = {
  id: 'item1',
  cartId: 'cart1',
  productId: 'prod1',
  variantId: 'var1',
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
  variantId: 'var1',
  sku: 'TSHIRT-M',
  optionValues: { size: 'M' },
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
const mockAddress = {
  id: mockAddressId,
  userId: mockUserId,
  country: 'GH',
  street: '1 Main St',
  city: 'Accra',
  recipientName: 'Ama Mensah',
  phone: '+233244123456',
  region: 'GREATER_ACCRA',
  zipCode: '00233',
};
const deliveryParams = {
  fulfillmentType: FulfillmentType.DELIVERY,
  shippingAddressId: mockAddressId,
  contactEmail: 'test@example.com',
  contactPhone: '+233244000000',
};
const pickupParams = {
  fulfillmentType: FulfillmentType.PICKUP,
  pickupLocationId: 'pickup1',
  contactEmail: 'test@example.com',
  contactPhone: '+233244000000',
};
const mockPickupLocation = {
  id: 'pickup1',
  name: 'Osu Store',
  address: '12 Oxford St',
  city: 'Accra',
  state: 'Greater Accra',
  country: 'Ghana',
  isActive: true,
  createdAt: fixedDate,
  updatedAt: fixedDate,
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
        { provide: StockLedgerService, useValue: mockStockLedger },
        { provide: OutboxService, useValue: mockOutbox },
        { provide: ShippingZonesService, useValue: mockShippingZonesService },
        { provide: PickupLocationsService, useValue: mockPickupLocationsService },
        { provide: ReturnsService, useValue: mockReturnsService },
        { provide: DiscountService, useValue: mockDiscountService },
        { provide: StoreService, useValue: mockStoreService },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    ordersRepository = module.get<OrdersRepository>(OrdersRepository) as jest.Mocked<OrdersRepository>;
    cartService = module.get(CartService);
    jest.resetAllMocks();
    mockStoreService.getCurrency.mockResolvedValue('GHS');

    // Default transaction mock: executes the callback with a stub tx
    mockOrdersRepository.runTransaction.mockImplementation(async (callback) => {
      const stubTx = {};
      return callback(stubTx as any);
    });
    mockOrdersRepository.runWithAdvisoryLock.mockImplementation((_key, _maxMs, fn: () => Promise<unknown>) => fn());
    // Default stock operations succeed: the variant is on sale and the reservation is made
    mockOrdersRepository.lockSellableVariant.mockResolvedValue(true);
    mockStockLedger.reserve.mockResolvedValue(true);
    mockStockLedger.releaseOrder.mockResolvedValue(1);
    mockStockLedger.consumeOrder.mockResolvedValue(0);
    mockOrdersRepository.create.mockResolvedValue(mockOrder);
    mockOrdersRepository.clearCartItems.mockResolvedValue(undefined);
    mockShippingZonesService.getFeeForCity.mockResolvedValue(new Decimal('5'));
    mockDiscountService.findActiveDiscountsByVariant.mockResolvedValue(new Map());
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
        recipientName: 'Ama Mensah',
        phone: '+233244123456',
        region: 'GREATER_ACCRA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      const result = await ordersService.createOrderFromCart(mockUserId, {
        fulfillmentType: FulfillmentType.DELIVERY,
        shippingAddressId: mockAddressId,
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
      });

      expect(cartService.getCartOrThrow).toHaveBeenCalledWith(mockUserId);
      expect(ordersRepository.create).toHaveBeenCalled();
      expect(result).toEqual(mockOrder);
    });

    it.each([
      ['an online order until it expires unpaid', 'ONLINE', 60 * 60 * 1000],
      ['a cash-on-delivery order until dispatch, with no expiry', 'CASH_ON_DELIVERY', null],
    ] as const)('reserves the stock of %s', async (_case, paymentMethod, expiresInMs) => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      const before = Date.now();

      await ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, paymentMethod });

      const [, line] = mockStockLedger.reserve.mock.calls[0] as [unknown, { expiresAt: Date | null }];
      if (expiresInMs === null) {
        expect(line.expiresAt).toBeNull();
      } else {
        expect(line.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + expiresInMs);
        expect(line.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + expiresInMs);
      }
    });

    it('records order.placed.v1 in the order transaction, after the order row is written', async () => {
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await ordersService.createOrderFromCart(mockUserId, deliveryParams);

      expect(mockOutbox.record).toHaveBeenCalledTimes(1);
      expect(mockOutbox.record).toHaveBeenCalledWith(stubTx, {
        type: 'order.placed.v1',
        aggregateId: mockOrder.id,
        payload: { orderId: mockOrder.id },
      });
      expect(mockOrdersRepository.create.mock.invocationCallOrder[0]).toBeLessThan(
        mockOutbox.record.mock.invocationCallOrder[0],
      );
    });

    it('records no order event when the order transaction fails', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockStockLedger.reserve.mockResolvedValue(false);

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(BadRequestException);
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('stores the subtotal and the shipping fee of the covering zone on a delivery order', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await ordersService.createOrderFromCart(mockUserId, deliveryParams);

      expect(mockShippingZonesService.getFeeForCity).toHaveBeenCalledWith('Accra');
      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          subtotal: new Decimal('39.98'),
          shippingFee: new Decimal('5'),
          totalAmount: new Decimal('44.98'),
        }),
      );
    });

    describe('with product discounts', () => {
      const tenPercentOff = { id: 'disc10', type: 'PERCENTAGE', value: new Decimal(10), minimumPurchase: null };

      beforeEach(() => {
        mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
        mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
        mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
        mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, price: new Decimal('100') });
        mockOrdersRepository.create.mockResolvedValue(mockOrder);
        mockDiscountService.findActiveDiscountsByVariant.mockResolvedValue(new Map([['var1', [tenPercentOff]]]));
      });

      it('charges the discounted price and records the list price and discount on each line', async () => {
        await ordersService.createOrderFromCart(mockUserId, deliveryParams);

        expect(mockDiscountService.findActiveDiscountsByVariant).toHaveBeenCalledWith([
          { id: 'var1', productId: 'prod1', categoryId: 'cat1', discountId: null },
        ]);
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            orderItems: [
              expect.objectContaining({
                productId: 'prod1',
                variantId: 'var1',
                quantity: 2,
                originalPrice: new Decimal('100'),
                priceAtOrder: new Decimal('90'),
                discountAmount: new Decimal('10'),
                discountId: 'disc10',
              }),
            ],
            subtotal: new Decimal('180'),
            discountTotal: new Decimal('20'),
            shippingFee: new Decimal('5'),
            totalAmount: new Decimal('185'),
          }),
        );
      });

      it('takes the coupon off the discounted subtotal, before shipping', async () => {
        mockCouponsService.validateCoupon.mockResolvedValue({
          discountAmount: new Decimal('18.00'),
          coupon: { id: 'coupon1' },
        });

        await ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, couponCode: 'SAVE10' });

        expect(mockCouponsService.validateCoupon).toHaveBeenCalledWith('SAVE10', mockUserId, new Decimal('180'));
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            couponId: 'coupon1',
            couponDiscount: new Decimal('18'),
            totalAmount: new Decimal('167'),
          }),
        );
      });
    });

    describe('with variants', () => {
      const large = {
        ...mockVariant,
        id: 'var2',
        sku: 'TSHIRT-L',
        optionValues: { size: 'L' },
        price: new Decimal('120'),
        stockLevels: [{ onHand: 10, reserved: 0 }],
        discountId: 'large20',
      };
      const productTenPercent = { id: 'product10', type: 'PERCENTAGE', value: new Decimal(10), minimumPurchase: null };
      const largeTwentyOff = { id: 'large20', type: 'FLAT', value: new Decimal(20), minimumPurchase: null };

      beforeEach(() => {
        mockCartService.getCartOrThrow.mockResolvedValue({
          ...mockCart,
          items: [
            { ...mockCartItem, variantId: 'var1', quantity: 2 },
            { ...mockCartItem, id: 'item2', variantId: 'var2', quantity: 1 },
          ],
        });
        mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
        mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
        mockOrdersRepository.findVariant.mockImplementation(async (id: string) =>
          id === 'var1' ? { ...mockVariant, price: new Decimal('100') } : large,
        );
        mockOrdersRepository.create.mockResolvedValue({
          ...mockOrder,
          items: [
            { ...mockOrderItem, id: 'orderItem1', variantId: 'var1', sku: 'TSHIRT-M', quantity: 2 },
            { ...mockOrderItem, id: 'orderItem2', variantId: 'var2', sku: 'TSHIRT-L', quantity: 1 },
          ],
        });
        mockDiscountService.findActiveDiscountsByVariant.mockResolvedValue(
          new Map([
            ['var1', [productTenPercent]],
            ['var2', [productTenPercent, largeTwentyOff]],
          ]),
        );
      });

      it('prices each line from its own variant, with a product discount on every variant and a variant discount on one', async () => {
        await ordersService.createOrderFromCart(mockUserId, deliveryParams);

        expect(mockOrdersRepository.findVariant).toHaveBeenCalledWith('var1');
        expect(mockOrdersRepository.findVariant).toHaveBeenCalledWith('var2');
        expect(mockDiscountService.findActiveDiscountsByVariant).toHaveBeenCalledWith([
          { id: 'var1', productId: 'prod1', categoryId: 'cat1', discountId: null },
          { id: 'var2', productId: 'prod1', categoryId: 'cat1', discountId: 'large20' },
        ]);
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            orderItems: [
              expect.objectContaining({
                variantId: 'var1',
                originalPrice: new Decimal('100'),
                priceAtOrder: new Decimal('90'),
                discountId: 'product10',
              }),
              expect.objectContaining({
                variantId: 'var2',
                originalPrice: new Decimal('120'),
                priceAtOrder: new Decimal('100'),
                discountId: 'large20',
              }),
            ],
            subtotal: new Decimal('280'),
            discountTotal: new Decimal('40'),
          }),
        );
      });

      it('snapshots each variant SKU and option values onto its order item', async () => {
        await ordersService.createOrderFromCart(mockUserId, deliveryParams);

        const [, , details] = mockOrdersRepository.create.mock.calls[0];
        expect(details.orderItems).toEqual([
          expect.objectContaining({
            productId: 'prod1',
            variantId: 'var1',
            sku: 'TSHIRT-M',
            optionValues: { size: 'M' },
          }),
          expect.objectContaining({
            productId: 'prod1',
            variantId: 'var2',
            sku: 'TSHIRT-L',
            optionValues: { size: 'L' },
          }),
        ]);
      });

      it('re-checks each variant is on sale and reserves its stock against its order line', async () => {
        await ordersService.createOrderFromCart(mockUserId, deliveryParams);

        expect(mockOrdersRepository.lockSellableVariant).toHaveBeenCalledWith({}, 'var1');
        expect(mockOrdersRepository.lockSellableVariant).toHaveBeenCalledWith({}, 'var2');
        const expiresAt = expect.any(Date);
        expect(mockStockLedger.reserve).toHaveBeenCalledWith(
          {},
          { variantId: 'var1', quantity: 2, orderId: 'order1', orderItemId: 'orderItem1', expiresAt },
          mockUserId,
        );
        expect(mockStockLedger.reserve).toHaveBeenCalledWith(
          {},
          { variantId: 'var2', quantity: 1, orderId: 'order1', orderItemId: 'orderItem2', expiresAt },
          mockUserId,
        );
      });

      it('checks stock per variant, so one short variant fails the order before any stock is taken', async () => {
        mockOrdersRepository.findVariant.mockImplementation(async (id: string) =>
          id === 'var1' ? mockVariant : { ...large, stockLevels: [{ onHand: 3, reserved: 3 }] },
        );

        await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
          new BadRequestException('Insufficient stock for "T-Shirt" (TSHIRT-L): 0 available, 1 requested'),
        );
        expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      });

      it('rolls back with the SKU named when a variant runs out inside the transaction', async () => {
        mockStockLedger.reserve.mockImplementation(
          async (_tx, line: { variantId: string }) => line.variantId === 'var1',
        );

        await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
          new BadRequestException('Variant "TSHIRT-L" is out of stock or no longer on sale — please review your cart'),
        );
        // The order row was written in the same transaction, which this error rolls back.
        expect(mockOutbox.record).not.toHaveBeenCalled();
        expect(mockOrdersRepository.clearCartItems).not.toHaveBeenCalled();
      });

      it('rolls back with the SKU named when a variant was taken off sale inside the transaction', async () => {
        mockOrdersRepository.lockSellableVariant.mockImplementation(async (_tx, id: string) => id === 'var1');

        await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
          new BadRequestException('Variant "TSHIRT-L" is out of stock or no longer on sale — please review your cart'),
        );
        expect(mockStockLedger.reserve).toHaveBeenCalledTimes(1);
        expect(mockOutbox.record).not.toHaveBeenCalled();
      });
    });

    it('rejects checkout of a variant without a price, without reserving stock', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, price: null });

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new BadRequestException('"T-Shirt" (TSHIRT-M) has no price and cannot be sold; remove it from the cart'),
      );
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
    });

    it.each([
      ['a variant of an unpublished product', { product: { ...mockProduct, status: 'DRAFT' } }, 'is not on sale'],
      ['a variant of an inactive product', { product: { ...mockProduct, isActive: false } }, 'is not on sale'],
      ['an archived variant', { isActive: false }, 'is no longer sold'],
    ])('rejects checkout of %s, without reserving stock', async (_case, change, reason) => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, ...change });

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new BadRequestException(`"T-Shirt" (TSHIRT-M) ${reason}; remove it from the cart`),
      );
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it('rejects a cart line whose variant no longer exists', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(null);

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new NotFoundException('Variant "var1" not found'),
      );
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
    });

    it('rejects delivery to a city no shipping zone covers, without reserving stock', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({ ...mockAddress, city: 'Tamale' });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockShippingZonesService.getFeeForCity.mockRejectedValue(
        new BadRequestException('Delivery is not available to city "Tamale": no active shipping zone covers it'),
      );

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(BadRequestException);
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it.each([
      ['region', { region: null }],
      ['recipient name', { recipientName: null }],
      ['phone', { phone: null }],
    ])('asks for the address to be completed when its %s is missing, without reserving stock', async (_, gap) => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({ ...mockAddress, ...gap });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new BadRequestException('Complete the delivery address (region, recipient name and phone) before checkout'),
      );
      expect(mockShippingZonesService.getFeeForCity).not.toHaveBeenCalled();
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it('snapshots the recipient, phone, region and location details of the delivery address', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        ...mockAddress,
        area: 'Osu',
        landmark: 'Opposite the Total filling station',
        ghanaPostGps: 'GA-123-4567',
        latitude: new Decimal('5.556'),
        longitude: new Decimal('-0.1969'),
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await ordersService.createOrderFromCart(mockUserId, deliveryParams);

      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          shippingAddressSnapshot: {
            recipientName: 'Ama Mensah',
            phone: '+233244123456',
            region: 'GREATER_ACCRA',
            street: '1 Main St',
            city: 'Accra',
            area: 'Osu',
            landmark: 'Opposite the Total filling station',
            ghanaPostGps: 'GA-123-4567',
            latitude: 5.556,
            longitude: -0.1969,
            zipCode: '00233',
            country: 'GH',
          },
        }),
      );
    });

    it('stores a zero shipping fee on a pickup order', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPickupLocationsService.findActiveById.mockResolvedValue(mockPickupLocation);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await ordersService.createOrderFromCart(mockUserId, pickupParams);

      expect(mockShippingZonesService.getFeeForCity).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          subtotal: new Decimal('39.98'),
          shippingFee: new Decimal('0'),
          totalAmount: new Decimal('39.98'),
        }),
      );
    });

    it('snapshots the pickup location onto a pickup order', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPickupLocationsService.findActiveById.mockResolvedValue(mockPickupLocation);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await ordersService.createOrderFromCart(mockUserId, pickupParams);

      expect(mockPickupLocationsService.findActiveById).toHaveBeenCalledWith('pickup1');
      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          pickupLocationId: 'pickup1',
          pickupLocationSnapshot: {
            name: 'Osu Store',
            address: '12 Oxford St',
            city: 'Accra',
            state: 'Greater Accra',
            country: 'Ghana',
          },
        }),
      );
    });

    it('rejects a pickup order for an unknown or inactive location, without reserving stock', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockPickupLocationsService.findActiveById.mockRejectedValue(
        new BadRequestException('Pickup location "pickup1" does not exist or is not active'),
      );

      await expect(ordersService.createOrderFromCart(mockUserId, pickupParams)).rejects.toThrow(BadRequestException);
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it.each(['USD', null])('rejects checkout of a product priced in %s, without reserving stock', async (currency) => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, product: { ...mockProduct, currency } });

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new BadRequestException(
          `"T-Shirt" is priced in ${currency ?? 'no currency'}; only GHS products can be checked out`,
        ),
      );
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
    });

    it('checks products against the store currency, not a fixed GHS', async () => {
      mockStoreService.getCurrency.mockResolvedValue('USD');
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);

      await expect(ordersService.createOrderFromCart(mockUserId, deliveryParams)).rejects.toThrow(
        new BadRequestException('"T-Shirt" is priced in GHS; only USD products can be checked out'),
      );
    });

    it('should throw NotFoundException if cart is empty', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue({ ...mockCart, items: [] });

      await expect(
        ordersService.createOrderFromCart(mockUserId, {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(new NotFoundException(`Cart for user "${mockUserId}" is empty`));
    });

    it('should throw NotFoundException if shipping address is invalid', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(null);

      await expect(
        ordersService.createOrderFromCart(mockUserId, {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(
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
        recipientName: 'Ama Mensah',
        phone: '+233244123456',
        region: 'GREATER_ACCRA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue({ ...mockUser, isActive: false });

      await expect(
        ordersService.createOrderFromCart(mockUserId, {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(new BadRequestException(`User "${mockUserId}" is not eligible to place an order`));
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
        recipientName: 'Ama Mensah',
        phone: '+233244123456',
        region: 'GREATER_ACCRA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);

      await expect(
        ordersService.createOrderFromCart(mockUserId, {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should roll back if stock goes negative inside transaction (oversell prevention)', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({
        id: mockAddressId,
        userId: mockUserId,
        country: 'GH',
        street: '1 Main St',
        city: 'Accra',
        recipientName: 'Ama Mensah',
        phone: '+233244123456',
        region: 'GREATER_ACCRA',
        zipCode: '00233',
      });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockStockLedger.reserve.mockResolvedValue(false);

      await expect(
        ordersService.createOrderFromCart(mockUserId, {
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(BadRequestException);
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
    const processingOrder = { ...mockOrder, status: OrderStatus.PROCESSING, paymentMethod: 'ONLINE' };

    it('should update order status and write audit log', async () => {
      const updatedOrder = { ...mockOrder, status: 'SHIPPED' as OrderStatus };
      mockOrdersRepository.findById.mockResolvedValue(processingOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue(updatedOrder);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1');

      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(expect.anything(), 'order1', OrderStatus.SHIPPED, [
        OrderStatus.PROCESSING,
      ]);
      const [tx] = ordersRepository.transitionStatus.mock.calls[0];
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', entityId: 'order1', action: 'STATUS_CHANGE', userId: 'admin1' }),
        tx,
      );
      expect(result.status).toBe('SHIPPED');
    });

    it.each([OrderStatus.SHIPPED, OrderStatus.DELIVERED])(
      'records order.status_changed.v1 for %s in the status-change transaction',
      async (status) => {
        const stubTx = { id: 'tx' };
        mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
        mockOrdersRepository.findById.mockResolvedValue(
          status === OrderStatus.SHIPPED ? processingOrder : { ...processingOrder, status: OrderStatus.SHIPPED },
        );
        mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status, trackingNumber: 'TRK1' });

        await ordersService.updateOrderStatus('order1', status, 'admin1');

        expect(mockOutbox.record).toHaveBeenCalledTimes(1);
        expect(mockOutbox.record).toHaveBeenCalledWith(stubTx, {
          type: 'order.status_changed.v1',
          aggregateId: 'order1',
          payload: { orderId: 'order1', status, trackingNumber: 'TRK1' },
        });
      },
    );

    it('records no event for a status change that emails nobody', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, paymentMethod: 'CASH_ON_DELIVERY' });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING });

      await ordersService.updateOrderStatus('order1', OrderStatus.PROCESSING, 'admin1');

      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockOrdersRepository.findById.mockResolvedValue(null);

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED)).rejects.toThrow(NotFoundException);
    });

    it('rejects a transition the table does not allow, without writing', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1')).rejects.toThrow(
        new ConflictException('Order "order1" cannot move from CANCELLED to SHIPPED'),
      );
      expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('does not let an admin mark an unpaid online order as PROCESSING', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, paymentMethod: 'ONLINE' });

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.PROCESSING, 'admin1')).rejects.toThrow(
        ConflictException,
      );
      expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
    });

    it('lets an admin move a cash-on-delivery order out of PENDING', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, paymentMethod: 'CASH_ON_DELIVERY' });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING });

      await ordersService.updateOrderStatus('order1', OrderStatus.PROCESSING, 'admin1');

      expect(ordersRepository.transitionStatus).toHaveBeenCalled();
      expect(mockStockLedger.consumeOrder).not.toHaveBeenCalled();
    });

    it('consumes the order reservations when it is dispatched, after the SHIPPED claim and in its transaction', async () => {
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockOrdersRepository.findById.mockResolvedValue({ ...processingOrder, paymentMethod: 'CASH_ON_DELIVERY' });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.SHIPPED });

      await ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1');

      expect(mockStockLedger.consumeOrder).toHaveBeenCalledWith(stubTx, 'order1', 'admin1');
      expect(mockOrdersRepository.transitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        mockStockLedger.consumeOrder.mock.invocationCallOrder[0],
      );
    });

    it('consumes nothing when the SHIPPED claim is lost to another request', async () => {
      mockOrdersRepository.findById.mockResolvedValue(processingOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1')).rejects.toThrow(
        ConflictException,
      );
      expect(mockStockLedger.consumeOrder).not.toHaveBeenCalled();
    });

    it('cancels through the real cancel path so stock comes back', async () => {
      mockOrdersRepository.findById.mockResolvedValue(processingOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });
      mockOrdersRepository.hasCompletedPayment.mockResolvedValue(false);

      await ordersService.updateOrderStatus('order1', OrderStatus.CANCELLED, 'admin1');

      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: 'admin1',
        note: 'Order cancelled',
      });
    });

    it('reports a conflict when another request changed the order first', async () => {
      mockOrdersRepository.findById.mockResolvedValue(processingOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1')).rejects.toThrow(
        /changed by another request/,
      );
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order and restore stock', async () => {
      const cancelledOrder = { ...mockOrder, status: 'CANCELLED' as OrderStatus };
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue(cancelledOrder);

      const result = await ordersService.cancelOrder(mockUserId, 'order1');

      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'order1',
        OrderStatus.CANCELLED,
        [OrderStatus.PENDING, OrderStatus.PROCESSING],
        undefined,
      );
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: mockUserId,
        note: 'Order cancelled',
      });
      expect(result.status).toBe('CANCELLED');
    });

    it('should throw ConflictException if order is already shipped', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: 'SHIPPED' as OrderStatus });

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(ConflictException);
      expect(mockStockLedger.releaseOrder).not.toHaveBeenCalled();
    });

    it('rejects cancelling an already cancelled order without restoring stock', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(ConflictException);
      expect(mockStockLedger.releaseOrder).not.toHaveBeenCalled();
    });

    it('restores no stock when a concurrent request cancelled the order first', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(/changed by another request/);
      expect(mockStockLedger.releaseOrder).not.toHaveBeenCalled();
    });

    it("should not allow cancelling another user's order", async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, userId: 'other-user' });

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteOrder (soft delete)', () => {
    const deliveredOrder = { ...mockOrder, status: OrderStatus.DELIVERED };

    it('should soft-delete a delivered order without moving stock', async () => {
      const deletedOrder = { ...deliveredOrder, deleted: true, deletedAt: new Date() };
      mockOrdersRepository.findById.mockResolvedValue(deliveredOrder);
      mockOrdersRepository.softDelete.mockResolvedValue(deletedOrder);
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.deleteOrder('order1', 'admin1');

      expect(ordersRepository.softDelete).toHaveBeenCalledWith(expect.anything(), 'order1', [
        OrderStatus.DELIVERED,
        OrderStatus.CANCELLED,
      ]);
      expect(mockStockLedger.releaseOrder).not.toHaveBeenCalled();
      const [tx] = ordersRepository.softDelete.mock.calls[0];
      expect(mockAuditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'Order', action: 'DELETE', userId: 'admin1' }),
        tx,
      );
      expect(result.deleted).toBe(true);
    });

    it('should throw NotFoundException if order does not exist', async () => {
      mockOrdersRepository.findById.mockResolvedValue(null);

      await expect(ordersService.deleteOrder('order1')).rejects.toThrow(NotFoundException);
    });

    it('refuses to delete an order that is still open, so its stock stays reserved correctly', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);

      await expect(ordersService.deleteOrder('order1', 'admin1')).rejects.toThrow(
        new ConflictException(
          'Order "order1" is PENDING; only DELIVERED or CANCELLED orders can be deleted (cancel it first)',
        ),
      );
      expect(ordersRepository.softDelete).not.toHaveBeenCalled();
    });

    it('refuses to delete an order twice', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...deliveredOrder, deleted: true });

      await expect(ordersService.deleteOrder('order1', 'admin1')).rejects.toThrow(/already deleted/);
      expect(ordersRepository.softDelete).not.toHaveBeenCalled();
    });

    it('reports a conflict when the order changed between the check and the write', async () => {
      mockOrdersRepository.findById.mockResolvedValue(deliveredOrder);
      mockOrdersRepository.softDelete.mockResolvedValue(null);

      await expect(ordersService.deleteOrder('order1', 'admin1')).rejects.toThrow(/changed by another request/);
      expect(mockAuditService.log).not.toHaveBeenCalled();
    });

    it('gives the coupon use back in the same transaction when the cancelled order used a coupon', async () => {
      const couponOrder = { ...mockOrder, couponId: 'coupon1' };
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockOrdersRepository.findById.mockResolvedValue(couponOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...couponOrder, status: OrderStatus.CANCELLED });

      await ordersService.cancelOrder(mockUserId, 'order1');

      expect(mockCouponsService.releaseUsage).toHaveBeenCalledWith(stubTx, 'order1');
    });

    it('releases no coupon use when the cancel lost the race to another request', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, couponId: 'coupon1' });
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(ConflictException);
      expect(mockCouponsService.releaseUsage).not.toHaveBeenCalled();
    });

    it('releases the order reservations once when cancelling, in the cancel transaction', async () => {
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });

      await ordersService.cancelOrder(mockUserId, 'order1');

      expect(mockStockLedger.releaseOrder).toHaveBeenCalledTimes(1);
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(stubTx, 'order1', expect.anything());
      expect(mockOrdersRepository.transitionStatus.mock.invocationCallOrder[0]).toBeLessThan(
        mockStockLedger.releaseOrder.mock.invocationCallOrder[0],
      );
    });
  });

  describe('audit trail in the same transaction', () => {
    const stubTx = { id: 'tx' };

    beforeEach(() => {
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockAuditService.log.mockResolvedValue(undefined);
    });

    it('audits an admin cancellation with from/to inside the cancel-and-restock transaction', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });
      await ordersService.adminCancelOrder('order1', 'admin1');

      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'Order',
          entityId: 'order1',
          action: 'STATUS_CHANGE',
          userId: 'admin1',
          details: { from: OrderStatus.PENDING, to: OrderStatus.CANCELLED },
        },
        stubTx,
      );
    });

    it('writes the shipping update and its audit entry on the same transaction', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.updateShipping.mockResolvedValue({ ...mockOrder, trackingNumber: 'TRK1', carrier: 'DHL' });

      await ordersService.updateShipping('order1', undefined, 'DHL', 'admin1');

      expect(mockOrdersRepository.updateShipping).toHaveBeenCalledWith('order1', undefined, 'DHL', stubTx);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        {
          entity: 'Order',
          entityId: 'order1',
          action: 'UPDATE',
          userId: 'admin1',
          details: { trackingNumber: undefined, carrier: 'DHL' },
        },
        stubTx,
      );
    });

    it('fails the status change from inside the transaction when the audit write fails, so it rolls back', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: OrderStatus.PROCESSING });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.SHIPPED });
      mockAuditService.log.mockRejectedValue(new Error('audit insert failed'));

      await expect(ordersService.updateOrderStatus('order1', OrderStatus.SHIPPED, 'admin1')).rejects.toThrow(
        'audit insert failed',
      );
      await expect(mockOrdersRepository.runTransaction.mock.results[0].value).rejects.toThrow('audit insert failed');
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('records order.shipment_updated.v1 with the tracking number in the shipping transaction', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.updateShipping.mockResolvedValue({ ...mockOrder, trackingNumber: 'TRK1', carrier: 'DHL' });

      await ordersService.updateShipping('order1', 'TRK1', 'DHL', 'admin1');

      expect(mockOutbox.record).toHaveBeenCalledWith(stubTx, {
        type: 'order.shipment_updated.v1',
        aggregateId: 'order1',
        payload: { orderId: 'order1', trackingNumber: 'TRK1' },
      });
    });

    it('records no shipment event when only the carrier changes', async () => {
      mockOrdersRepository.findById.mockResolvedValue(mockOrder);
      mockOrdersRepository.updateShipping.mockResolvedValue({ ...mockOrder, carrier: 'DHL' });

      await ordersService.updateShipping('order1', undefined, 'DHL', 'admin1');

      expect(mockOutbox.record).not.toHaveBeenCalled();
    });
  });

  describe('expireAbandonedOrders', () => {
    it('skips orders that were paid or cancelled since they were selected and expires the rest', async () => {
      const second = { ...mockOrder, id: 'order2' };
      mockOrdersRepository.findExpiredPendingOrders.mockResolvedValue([mockOrder, second]);
      mockOrdersRepository.transitionStatus
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...second, status: OrderStatus.CANCELLED });

      const expired = await ordersService.expireAbandonedOrders(24);

      expect(expired).toBe(1);
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledTimes(1);
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order2', {
        actorId: undefined,
        note: 'Unpaid order expired',
      });
    });

    it('claims each order only while it still matches the expiry rule, so a restarted payment is not cancelled', async () => {
      mockOrdersRepository.findExpiredPendingOrders.mockResolvedValue([mockOrder]);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });

      await ordersService.expireAbandonedOrders(1);

      const cutoff: Date = mockOrdersRepository.findExpiredPendingOrders.mock.calls[0][0];
      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'order1',
        OrderStatus.CANCELLED,
        [OrderStatus.PENDING, OrderStatus.PROCESSING],
        abandonedOrderWhere(cutoff),
      );
    });

    it('does nothing and returns null when another instance holds the expiry lock', async () => {
      mockOrdersRepository.runWithAdvisoryLock.mockResolvedValue(null);

      const expired = await ordersService.expireAbandonedOrders(1);

      expect(expired).toBeNull();
      expect(ordersRepository.runWithAdvisoryLock).toHaveBeenCalledWith(
        ORDER_EXPIRY_LOCK_KEY,
        expect.any(Number),
        expect.any(Function),
      );
      expect(ordersRepository.findExpiredPendingOrders).not.toHaveBeenCalled();
      expect(ordersRepository.transitionStatus).not.toHaveBeenCalled();
    });
  });
});
