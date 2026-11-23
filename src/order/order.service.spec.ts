import { Test, TestingModule } from '@nestjs/testing';
import { PaymentSettingsService } from '../payment/settings/payment-settings.service';
import { CartService } from '../cart/cart.service';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';
import { CreateOrderParams, ORDER_EXPIRY_LOCK_KEY, OrdersService } from './order.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { abandonedOrderWhere, OrdersRepository } from './order.repository';
import { AuditService } from '../commons/audit.service';
import { TaxService } from '../tax/tax.service';
import { StockLedgerService } from '../inventory/stock-ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { Decimal } from '@prisma/client/runtime/client';
import { ShippingZonesService } from '../shipping-zones/shipping-zones.service';
import { PickupLocationsService } from '../pickup-locations/pickup-locations.service';
import { FulfillmentType, PaymentMethod } from '../generated/prisma/client';
import { ReturnsService } from '../returns/returns.service';
import { PromotionsService } from '../promotions/promotions.service';
import { PriceListsService } from '../price-lists/price-lists.service';
import { PricingCouponCode, PricingPromotion } from '../pricing/price';
import { StoreService } from '../store/store.service';
import { VelocityService } from '../fraud/velocity.service';
import { codRiskStub, velocityStub } from '../../test/helpers/velocity.helper';
import { CodRiskService } from '../cod/cod-risk.service';
import { StockLocationsService } from '../inventory/locations/stock-locations.service';

const mockAuditService = { log: jest.fn() };
const mockTaxService = { findActive: jest.fn() };
const mockStockLedger = { reserve: jest.fn(), consumeOrder: jest.fn(), releaseOrder: jest.fn() };
const mockOutbox = { record: jest.fn() };
const zoneWithFee = (fee: string | number) => ({ id: 'zone1', fee: new Decimal(fee) });
const mockShippingZonesService = { getZoneForCity: jest.fn().mockResolvedValue(zoneWithFee('5')) };
const mockPickupLocationsService = { findActiveById: jest.fn() };
const mockReturnsService = { createSystemReturnRequest: jest.fn() };
const mockPriceListsService = { findForPricing: jest.fn() };

const mockPromotionsService = {
  findForPricing: jest.fn(),
  reserveRedemptions: jest.fn(),
  releaseRedemptions: jest.fn(),
};
/** A promotion as the pricing engine takes it, live and without limits. */
const candidate = (
  id: string,
  type: PricingPromotion['type'],
  value: number,
  targets: Partial<PricingPromotion>,
): PricingPromotion => ({
  id,
  name: id,
  description: null,
  scope: 'PRODUCT',
  type,
  value: new Decimal(value),
  minimumSpend: null,
  minimumQuantity: null,
  startsAt: new Date(Date.now() - 86_400_000),
  endsAt: new Date(Date.now() + 86_400_000),
  isActive: true,
  priority: 0,
  stackingGroup: 'default',
  exclusive: false,
  requiresCoupon: false,
  usageLimit: null,
  usedCount: 0,
  unitCap: null,
  unitsUsed: 0,
  buyQuantity: null,
  getQuantity: null,
  maxApplications: null,
  rewardTargetIds: [],
  tierValueType: null,
  tiers: [],
  shippingZoneIds: [],
  perCustomerLimit: null,
  firstOrderOnly: false,
  customerGroupIds: [],
  createdAt: new Date(0),
  targetIds: [],
  ...targets,
});
/** What PromotionsService.findForPricing gives the order service. */
const pricingFacts = (promotions: PricingPromotion[], couponCode?: PricingCouponCode) => ({
  promotions,
  couponCode,
  customer: { redemptions: {}, groupIds: [], hasPriorOrder: false },
});
/** A coupon code unlocking a CART promotion, as a legacy coupon became. */
const couponFacts = (
  code: string,
  type: PricingPromotion['type'],
  value: number,
  overrides: Partial<PricingPromotion> = {},
) =>
  pricingFacts(
    [candidate('coupon1', type, value, { scope: 'CART', requiresCoupon: true, endsAt: null, ...overrides })],
    { id: 'code1', code, promotionId: 'coupon1', isActive: true, usageLimit: null, usedCount: 0 },
  );
const mockStoreService = { getCurrency: jest.fn() };

const mockOrdersRepository = {
  findById: jest.fn(),
  findByUser: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  transitionStatus: jest.fn(),
  softDelete: jest.fn(),
  lockForFulfilment: jest.fn(),
  cancelOpenShipments: jest.fn(),
  findForTransaction: jest.fn(),
  cancelOpenPaymentIntent: jest.fn(),
  findExpiredPendingOrders: jest.fn(),
  hasCapturedPayment: jest.fn(),
  findAddressForUser: jest.fn(),
  findUserById: jest.fn(),
  lockSellableVariant: jest.fn(),
  lockCart: jest.fn(),
  lockVariants: jest.fn(),
  findVariant: jest.fn(),
  findExpiredLotUnits: jest.fn(),
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
  isTaxable: false,
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
  basePrice: null,
  stockLevels: [{ onHand: 100, reserved: 0, locationId: 'loc_main' }],
  isActive: true,
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
  status: 'PLACED' as OrderStatus,
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

const mockPaymentSettings = { assertOrderPaymentMethod: jest.fn() };
const mockStockLocations = { candidatesFor: jest.fn(), lockFulfilmentLocation: jest.fn() };
const mockVelocity = velocityStub();
const mockCodRisk = codRiskStub();

describe('OrdersService', () => {
  let ordersService: OrdersService;
  let placeOrder: (params: Omit<CreateOrderParams, 'quoteHash'>) => ReturnType<OrdersService['createOrderFromCart']>;
  let ordersRepository: jest.Mocked<OrdersRepository>;
  let cartService: jest.Mocked<typeof mockCartService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: OrdersRepository, useValue: mockOrdersRepository },
        { provide: CartService, useValue: mockCartService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: TaxService, useValue: mockTaxService },
        { provide: StockLedgerService, useValue: mockStockLedger },
        { provide: OutboxService, useValue: mockOutbox },
        { provide: ShippingZonesService, useValue: mockShippingZonesService },
        { provide: PickupLocationsService, useValue: mockPickupLocationsService },
        { provide: ReturnsService, useValue: mockReturnsService },
        { provide: PromotionsService, useValue: mockPromotionsService },
        { provide: PriceListsService, useValue: mockPriceListsService },
        { provide: StoreService, useValue: mockStoreService },
        { provide: PaymentSettingsService, useValue: mockPaymentSettings },
        { provide: VelocityService, useValue: mockVelocity },
        { provide: CodRiskService, useValue: mockCodRisk },
        { provide: StockLocationsService, useValue: mockStockLocations },
        {
          provide: SerialUnitsService,
          useValue: { releaseOrder: jest.fn() },
        },
      ],
    }).compile();

    ordersService = module.get<OrdersService>(OrdersService);
    // Places an order the way a client does: quote first, then createOrder with the quote's hash.
    placeOrder = async (params) => {
      const { quoteHash } = await ordersService.checkoutQuote(mockUserId, params);
      return ordersService.createOrderFromCart(mockUserId, { ...params, quoteHash });
    };
    ordersRepository = module.get<OrdersRepository>(OrdersRepository) as jest.Mocked<OrdersRepository>;
    cartService = module.get(CartService);
    jest.resetAllMocks();
    mockOrdersRepository.findExpiredLotUnits.mockResolvedValue([]);
    Object.assign(mockCodRisk, codRiskStub());
    mockStoreService.getCurrency.mockResolvedValue('GHS');
    mockTaxService.findActive.mockResolvedValue([]);
    mockStockLocations.candidatesFor.mockResolvedValue(['loc_main']);
    mockStockLocations.lockFulfilmentLocation.mockResolvedValue({ locationId: 'loc_main' });

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
    mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CONFIRMED });
    mockOrdersRepository.clearCartItems.mockResolvedValue(undefined);
    mockShippingZonesService.getZoneForCity.mockResolvedValue(zoneWithFee('5'));
    mockPromotionsService.findForPricing.mockResolvedValue(pricingFacts([]));
    mockPriceListsService.findForPricing.mockResolvedValue([]);
  });

  describe('createOrderFromCart', () => {
    describe('velocity checks', () => {
      const softHit = { rule: 'ORDERS_PER_CUSTOMER_1H', level: 'SOFT', count: 4, limit: 3 };

      beforeEach(() => {
        mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
        mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
        mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
        mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
        mockOrdersRepository.create.mockResolvedValue(mockOrder);
      });

      it('screens the customer, phone and IP before placing, flags soft hits in the order transaction, then counts the order', async () => {
        mockVelocity.screenOrRefuse.mockResolvedValueOnce([softHit]);
        const { quoteHash } = await ordersService.checkoutQuote(mockUserId, deliveryParams);

        await ordersService.createOrderFromCart(mockUserId, {
          ...deliveryParams,
          quoteHash,
          clientIp: '::ffff:41.66.1.2',
        });

        const subjects = { CUSTOMER: mockUserId, PHONE: '+233244000000', IP: '41.66.1.2' };
        expect(mockVelocity.screenOrRefuse).toHaveBeenCalledWith('ORDER_PLACEMENT', subjects);
        expect(mockVelocity.flagOrder).toHaveBeenCalledWith(mockOrder.id, [softHit], expect.anything());
        expect(mockVelocity.record).toHaveBeenCalledWith('ORDER_PLACED', subjects);
      });

      it('places nothing and counts nothing when a hard limit refuses the order', async () => {
        const { quoteHash } = await ordersService.checkoutQuote(mockUserId, deliveryParams);
        mockVelocity.screenOrRefuse.mockRejectedValueOnce(new ForbiddenException('Too many orders'));

        await expect(ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, quoteHash })).rejects.toThrow(
          ForbiddenException,
        );
        expect(mockOrdersRepository.create).not.toHaveBeenCalled();
        expect(mockVelocity.record).not.toHaveBeenCalled();
      });
    });

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

      const result = await placeOrder({
        fulfillmentType: FulfillmentType.DELIVERY,
        shippingAddressId: mockAddressId,
        contactEmail: 'test@example.com',
        contactPhone: '+233244000000',
      });

      expect(cartService.getCartOrThrow).toHaveBeenLastCalledWith(mockUserId, {});
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

      await placeOrder({ ...deliveryParams, paymentMethod });

      const [, line] = mockStockLedger.reserve.mock.calls[0] as [unknown, { expiresAt: Date | null }];
      if (expiresInMs === null) {
        expect(line.expiresAt).toBeNull();
      } else {
        expect(line.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + expiresInMs);
        expect(line.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + expiresInMs);
      }
    });

    describe('cash-on-delivery risk gates', () => {
      beforeEach(() => {
        mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
        mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
        mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
        mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
        mockOrdersRepository.create.mockResolvedValue(mockOrder);
      });

      it('reports in the quote whether the checkout could be paid on delivery, with the zone and address', async () => {
        mockCodRisk.availability.mockResolvedValueOnce({
          available: false,
          reason: 'ORDER_TOTAL_ABOVE_CAP',
          phoneVerified: true,
        });

        const quote = await ordersService.checkoutQuote(mockUserId, deliveryParams);

        expect(quote.cashOnDelivery).toEqual({
          available: false,
          reason: 'ORDER_TOTAL_ABOVE_CAP',
          phoneVerified: true,
        });
        expect(mockCodRisk.availability).toHaveBeenCalledWith(mockUserId, {
          grandTotal: quote.grandTotal,
          shippingZoneId: zoneWithFee('5').id,
          address: mockAddress,
        });
      });

      it('checks the gates in the order transaction and records the verified phone on a COD order', async () => {
        const stubTx = { id: 'tx' };
        mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));

        await placeOrder({ ...deliveryParams, paymentMethod: PaymentMethod.CASH_ON_DELIVERY });

        expect(mockCodRisk.assertCodAllowed).toHaveBeenCalledWith(
          stubTx,
          mockUserId,
          expect.objectContaining({ address: mockAddress, contactPhone: deliveryParams.contactPhone }),
        );
        const [, , details] = mockOrdersRepository.create.mock.calls[0];
        expect(details.codPhone).toBe('+233244000000');
      });

      it('places nothing when a gate refuses cash on delivery', async () => {
        mockCodRisk.assertCodAllowed.mockRejectedValueOnce(new BadRequestException('COD refused'));

        await expect(placeOrder({ ...deliveryParams, paymentMethod: PaymentMethod.CASH_ON_DELIVERY })).rejects.toThrow(
          'COD refused',
        );
        expect(mockOrdersRepository.create).not.toHaveBeenCalled();
      });

      it('does not gate an online order', async () => {
        await placeOrder(deliveryParams);

        expect(mockCodRisk.assertCodAllowed).not.toHaveBeenCalled();
        const [, , details] = mockOrdersRepository.create.mock.calls[0];
        expect(details.codPhone).toBeUndefined();
      });
    });

    it('records order.placed.v1 in the order transaction, after the order row is written', async () => {
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await placeOrder(deliveryParams);

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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(BadRequestException);
      expect(mockOutbox.record).not.toHaveBeenCalled();
    });

    it('stores the subtotal and the shipping fee of the covering zone on a delivery order', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await placeOrder(deliveryParams);

      expect(mockShippingZonesService.getZoneForCity).toHaveBeenLastCalledWith('Accra', {});
      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          snapshot: expect.objectContaining({
            subtotal: new Decimal('39.98'),
            shippingTotal: new Decimal('5'),
            grandTotal: new Decimal('44.98'),
          }),
        }),
      );
    });

    it('snapshots the tax a taxable variant price includes, one line per active tax, and none on other lines', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        price: new Decimal('115'),
        basePrice: new Decimal('100'),
        product: { ...mockProduct, isTaxable: true },
      });
      mockTaxService.findActive.mockResolvedValue([
        { id: 'vat', name: 'VAT', rate: new Decimal('0.1') },
        { id: 'nhil', name: 'NHIL', rate: new Decimal('0.05') },
      ]);

      await placeOrder(deliveryParams);

      const [, , details] = mockOrdersRepository.create.mock.calls[0];
      const [line] = details.snapshot.lines;
      expect([line.unitNet, line.unitTax, line.lineTotal].map(String)).toEqual(['100', '15', '230']);
      expect(line.taxLines.map((t: { taxId: string; amount: Decimal }) => [t.taxId, String(t.amount)])).toEqual([
        ['nhil', '10'],
        ['vat', '20'],
      ]);
      expect(String(details.snapshot.taxTotal)).toBe('30');
      expect(String(details.snapshot.grandTotal)).toBe('235');
    });

    describe('with product discounts', () => {
      const tenPercentOff = candidate('disc10', 'PERCENT', 10, { targetIds: ['prod1'] });

      beforeEach(() => {
        mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
        mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
        mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
        mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, price: new Decimal('100') });
        mockOrdersRepository.create.mockResolvedValue(mockOrder);
        mockPromotionsService.findForPricing.mockResolvedValue(pricingFacts([tenPercentOff]));
      });

      it('charges the discounted price and records the list price and discount on each line', async () => {
        await placeOrder(deliveryParams);

        expect(mockPromotionsService.findForPricing).toHaveBeenLastCalledWith(
          { variantIds: ['var1'], productIds: ['prod1'], categoryIds: ['cat1'], brandIds: [] },
          mockUserId,
          undefined,
          expect.any(Date),
          {},
        );
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            snapshot: expect.objectContaining({
              lines: [
                expect.objectContaining({
                  productId: 'prod1',
                  variantId: 'var1',
                  quantity: 2,
                  unitListPrice: new Decimal('100'),
                  unitDiscount: new Decimal('10'),
                  lineTotal: new Decimal('180'),
                  adjustments: [{ type: 'DISCOUNT', sourceId: 'disc10', code: null, amount: new Decimal('-20') }],
                }),
              ],
              subtotal: new Decimal('200'),
              discountTotal: new Decimal('20'),
              shippingTotal: new Decimal('5'),
              grandTotal: new Decimal('185'),
            }),
          }),
        );
      });

      it('takes the coupon off the discounted subtotal, before shipping', async () => {
        const { promotions, couponCode } = couponFacts('SAVE10', 'PERCENT', 10);
        mockPromotionsService.findForPricing.mockResolvedValue(
          pricingFacts([tenPercentOff, ...promotions], couponCode),
        );

        await placeOrder({ ...deliveryParams, couponCode: 'SAVE10' });

        // 10% of the discounted 180.
        expect(mockPromotionsService.findForPricing).toHaveBeenLastCalledWith(
          expect.anything(),
          mockUserId,
          'SAVE10',
          expect.any(Date),
          {},
        );
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            couponCodeId: 'code1',
            snapshot: expect.objectContaining({
              adjustments: [
                {
                  type: 'COUPON',
                  sourceId: 'coupon1',
                  code: 'SAVE10',
                  amount: new Decimal('-18'),
                  allocations: [new Decimal('-18')],
                },
              ],
              grandTotal: new Decimal('167'),
            }),
          }),
        );
        expect(mockPromotionsService.reserveRedemptions).toHaveBeenCalledWith(
          {},
          { orderId: 'order1', customerId: mockUserId },
          ['disc10', 'coupon1'],
          expect.objectContaining({ id: 'code1', promotionId: 'coupon1' }),
          { disc10: 2 },
        );
      });

      it('records no coupon code on the order when its promotion takes nothing off', async () => {
        const { promotions, couponCode } = couponFacts('SAVE10', 'AMOUNT_OFF', 0);
        mockPromotionsService.findForPricing.mockResolvedValue(
          pricingFacts([tenPercentOff, ...promotions], couponCode),
        );

        await placeOrder({ ...deliveryParams, couponCode: 'SAVE10' });

        const [, , details] = mockOrdersRepository.create.mock.calls[0];
        expect(details.couponCodeId).toBeUndefined();
        expect(mockPromotionsService.reserveRedemptions).toHaveBeenCalledWith(
          {},
          expect.anything(),
          ['disc10'],
          undefined,
          { disc10: 2 },
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
        stockLevels: [{ onHand: 10, reserved: 0, locationId: 'loc_main' }],
      };
      const productTenPercent = candidate('product10', 'PERCENT', 10, { targetIds: ['prod1'] });
      const largeTwentyOff = candidate('large20', 'AMOUNT_OFF', 20, { scope: 'SKU', targetIds: ['var2'] });

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
        mockPromotionsService.findForPricing.mockResolvedValue(pricingFacts([productTenPercent, largeTwentyOff]));
      });

      it('prices each line from its own variant, with a product discount on every variant and a variant discount on one', async () => {
        await placeOrder(deliveryParams);

        expect(mockOrdersRepository.findVariant).toHaveBeenCalledWith('var1', {});
        expect(mockOrdersRepository.findVariant).toHaveBeenCalledWith('var2', {});
        expect(mockPromotionsService.findForPricing).toHaveBeenLastCalledWith(
          { variantIds: ['var1', 'var2'], productIds: ['prod1'], categoryIds: ['cat1'], brandIds: [] },
          mockUserId,
          undefined,
          expect.any(Date),
          {},
        );
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          expect.anything(),
          mockUserId,
          expect.objectContaining({
            snapshot: expect.objectContaining({
              lines: [
                expect.objectContaining({
                  variantId: 'var1',
                  unitListPrice: new Decimal('100'),
                  unitDiscount: new Decimal('10'),
                  lineTotal: new Decimal('180'),
                  adjustments: [expect.objectContaining({ sourceId: 'product10' })],
                }),
                expect.objectContaining({
                  variantId: 'var2',
                  unitListPrice: new Decimal('120'),
                  unitDiscount: new Decimal('20'),
                  lineTotal: new Decimal('100'),
                  adjustments: [expect.objectContaining({ sourceId: 'large20' })],
                }),
              ],
              subtotal: new Decimal('320'),
              discountTotal: new Decimal('40'),
              grandTotal: new Decimal('285'),
            }),
          }),
        );
      });

      it('snapshots each variant SKU and option values onto its order item', async () => {
        await placeOrder(deliveryParams);

        const [, , details] = mockOrdersRepository.create.mock.calls[0];
        expect(details.snapshot.lines).toEqual([
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
        await placeOrder(deliveryParams);

        expect(mockOrdersRepository.lockSellableVariant).toHaveBeenCalledWith({}, 'var1');
        expect(mockOrdersRepository.lockSellableVariant).toHaveBeenCalledWith({}, 'var2');
        const expiresAt = expect.any(Date);
        expect(mockStockLedger.reserve).toHaveBeenCalledWith(
          {},
          {
            variantId: 'var1',
            quantity: 2,
            orderId: 'order1',
            orderItemId: 'orderItem1',
            expiresAt,
            locationId: 'loc_main',
          },
          mockUserId,
        );
        expect(mockStockLedger.reserve).toHaveBeenCalledWith(
          {},
          {
            variantId: 'var2',
            quantity: 1,
            orderId: 'order1',
            orderItemId: 'orderItem2',
            expiresAt,
            locationId: 'loc_main',
          },
          mockUserId,
        );
      });

      it('checks stock per variant, so one short variant fails the order before any stock is taken', async () => {
        mockOrdersRepository.findVariant.mockImplementation(async (id: string) =>
          id === 'var1' ? mockVariant : { ...large, stockLevels: [{ onHand: 3, reserved: 3, locationId: 'loc_main' }] },
        );

        await expect(placeOrder(deliveryParams)).rejects.toThrow(
          new BadRequestException('Insufficient stock for "T-Shirt" (TSHIRT-L): 0 available, 1 requested'),
        );
        expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      });

      it('reserves every line at the location chosen for the delivery zone and stores it on the order', async () => {
        mockStockLocations.candidatesFor.mockResolvedValue(['loc_branch', 'loc_main']);
        mockStockLocations.lockFulfilmentLocation.mockResolvedValue({ locationId: 'loc_branch' });
        mockOrdersRepository.findVariant.mockImplementation(async (id: string) => ({
          ...(id === 'var1' ? mockVariant : large),
          stockLevels: [{ onHand: 10, reserved: 0, locationId: 'loc_branch' }],
        }));

        await placeOrder(deliveryParams);

        expect(mockStockLocations.candidatesFor).toHaveBeenCalledWith({ shippingZoneId: 'zone1' }, undefined);
        expect(mockStockLocations.lockFulfilmentLocation).toHaveBeenCalledWith(
          {},
          ['loc_branch', 'loc_main'],
          expect.arrayContaining([expect.objectContaining({ variantId: 'var1' })]),
        );
        expect(mockOrdersRepository.create).toHaveBeenCalledWith(
          {},
          mockUserId,
          expect.objectContaining({ stockLocationId: 'loc_branch' }),
        );
        for (const [, line] of mockStockLedger.reserve.mock.calls) {
          expect(line).toEqual(expect.objectContaining({ locationId: 'loc_branch' }));
        }
      });

      it('ignores stock at locations that do not fulfil the delivery when checking a line', async () => {
        mockStockLocations.candidatesFor.mockResolvedValue(['loc_branch']);

        await expect(ordersService.checkoutQuote(mockUserId, deliveryParams)).rejects.toThrow(
          new BadRequestException('Insufficient stock for "T-Shirt" (TSHIRT-M): 0 available, 2 requested'),
        );
      });

      it('refuses a cart whose lines are each in stock somewhere but not all at one location', async () => {
        mockStockLocations.candidatesFor.mockResolvedValue(['loc_a', 'loc_b']);
        mockOrdersRepository.findVariant.mockImplementation(async (id: string) => ({
          ...(id === 'var1' ? mockVariant : large),
          stockLevels: [{ onHand: 10, reserved: 0, locationId: id === 'var1' ? 'loc_a' : 'loc_b' }],
        }));

        await expect(ordersService.checkoutQuote(mockUserId, deliveryParams)).rejects.toThrow(
          'not all in stock at one location',
        );
      });

      it('refuses with the SKU named when no location can fill a line once the stock is locked', async () => {
        mockStockLocations.lockFulfilmentLocation.mockResolvedValue({ locationId: null, shortVariantId: 'var2' });

        await expect(placeOrder(deliveryParams)).rejects.toThrow(
          new BadRequestException('Variant "TSHIRT-L" is out of stock or no longer on sale — please review your cart'),
        );
        expect(mockOrdersRepository.create).not.toHaveBeenCalled();
        expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      });

      it('rolls back with the SKU named when a variant runs out inside the transaction', async () => {
        mockStockLedger.reserve.mockImplementation(
          async (_tx, line: { variantId: string }) => line.variantId === 'var1',
        );

        await expect(placeOrder(deliveryParams)).rejects.toThrow(
          new BadRequestException('Variant "TSHIRT-L" is out of stock or no longer on sale — please review your cart'),
        );
        // The order row was written in the same transaction, which this error rolls back.
        expect(mockOutbox.record).not.toHaveBeenCalled();
        expect(mockOrdersRepository.clearCartItems).not.toHaveBeenCalled();
      });

      it('rolls back with the SKU named when a variant was taken off sale inside the transaction', async () => {
        mockOrdersRepository.lockSellableVariant.mockImplementation(async (_tx, id: string) => id === 'var1');

        await expect(placeOrder(deliveryParams)).rejects.toThrow(
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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(
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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(
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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(new NotFoundException('Variant "var1" not found'));
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
    });

    it('rejects delivery to a city no shipping zone covers, without reserving stock', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue({ ...mockAddress, city: 'Tamale' });
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockShippingZonesService.getZoneForCity.mockRejectedValue(
        new BadRequestException('Delivery is not available to city "Tamale": no active shipping zone covers it'),
      );

      await expect(placeOrder(deliveryParams)).rejects.toThrow(BadRequestException);
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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(
        new BadRequestException('Complete the delivery address (region, recipient name and phone) before checkout'),
      );
      expect(mockShippingZonesService.getZoneForCity).not.toHaveBeenCalled();
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

      await placeOrder(deliveryParams);

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

      await placeOrder(pickupParams);

      expect(mockShippingZonesService.getZoneForCity).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).toHaveBeenCalledWith(
        expect.anything(),
        mockUserId,
        expect.objectContaining({
          snapshot: expect.objectContaining({
            subtotal: new Decimal('39.98'),
            shippingTotal: new Decimal('0'),
            grandTotal: new Decimal('39.98'),
          }),
        }),
      );
    });

    it('snapshots the pickup location onto a pickup order', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockPickupLocationsService.findActiveById.mockResolvedValue(mockPickupLocation);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue(mockVariant);
      mockOrdersRepository.create.mockResolvedValue(mockOrder);

      await placeOrder(pickupParams);

      expect(mockPickupLocationsService.findActiveById).toHaveBeenLastCalledWith('pickup1', {});
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

      await expect(placeOrder(pickupParams)).rejects.toThrow(BadRequestException);
      expect(mockStockLedger.reserve).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it.each(['USD', null])('rejects checkout of a product priced in %s, without reserving stock', async (currency) => {
      mockCartService.getCartOrThrow.mockResolvedValue(mockCart);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockResolvedValue({ ...mockVariant, product: { ...mockProduct, currency } });

      await expect(placeOrder(deliveryParams)).rejects.toThrow(
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

      await expect(placeOrder(deliveryParams)).rejects.toThrow(
        new BadRequestException('"T-Shirt" is priced in GHS; only USD products can be checked out'),
      );
    });

    it('should throw NotFoundException if cart is empty', async () => {
      mockCartService.getCartOrThrow.mockResolvedValue({ ...mockCart, items: [] });

      await expect(
        placeOrder({
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
        placeOrder({
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
        placeOrder({
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
        placeOrder({
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
        placeOrder({
          fulfillmentType: FulfillmentType.DELIVERY,
          shippingAddressId: mockAddressId,
          contactEmail: 'test@example.com',
          contactPhone: '+233244000000',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('checkoutQuote and the quote check in createOrderFromCart', () => {
    const coupon = couponFacts('SAVE', 'AMOUNT_OFF', 10);
    const twoLines = {
      ...mockCart,
      items: [
        { ...mockCartItem, id: 'item1', variantId: 'var1', quantity: 1 },
        { ...mockCartItem, id: 'item2', variantId: 'var2', quantity: 1 },
      ],
    };

    beforeEach(() => {
      mockCartService.getCartOrThrow.mockResolvedValue(twoLines);
      mockOrdersRepository.findAddressForUser.mockResolvedValue(mockAddress);
      mockOrdersRepository.findUserById.mockResolvedValue(mockUser);
      mockOrdersRepository.findVariant.mockImplementation(async (id: string) => ({
        ...mockVariant,
        id,
        sku: id.toUpperCase(),
        price: new Decimal('10'),
        basePrice: new Decimal('9'),
        product: { ...mockProduct, isTaxable: true },
      }));
      mockPromotionsService.findForPricing.mockResolvedValue(coupon);
    });

    it('prices the cart without writing, naming each line and coupon share by cart item', async () => {
      const quote = await ordersService.checkoutQuote(mockUserId, { ...deliveryParams, couponCode: 'SAVE' });

      expect(quote.quoteHash).toMatch(/^[0-9a-f]{64}$/);
      expect(quote.lines.map((l) => [l.cartItemId, l.variantId, l.sku, String(l.lineTotal)])).toEqual([
        ['item1', 'var1', 'VAR1', '10'],
        ['item2', 'var2', 'VAR2', '10'],
      ]);
      expect(quote.adjustments).toEqual([
        {
          type: 'COUPON',
          sourceId: 'coupon1',
          code: 'SAVE',
          amount: new Decimal(-10),
          allocations: [
            { cartItemId: 'item1', amount: new Decimal(-5) },
            { cartItemId: 'item2', amount: new Decimal(-5) },
          ],
        },
      ]);
      expect(String(quote.grandTotal)).toBe('15');
      expect(mockOrdersRepository.runTransaction).not.toHaveBeenCalled();
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
      expect(mockOrdersRepository.lockCart).not.toHaveBeenCalled();
    });

    it("places the order at the quote's grand total when the hash matches", async () => {
      const quote = await ordersService.checkoutQuote(mockUserId, deliveryParams);

      await ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, quoteHash: quote.quoteHash });

      const [, , details] = mockOrdersRepository.create.mock.calls[0];
      expect(details.snapshot.grandTotal).toEqual(quote.grandTotal);
      expect(details.snapshot.quoteHash).toBe(quote.quoteHash);
    });

    it('locks the cart, then the variants in the order transaction, before reading their prices', async () => {
      const tx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(tx as any));
      const quote = await ordersService.checkoutQuote(mockUserId, deliveryParams);

      await ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, quoteHash: quote.quoteHash });

      expect(mockOrdersRepository.lockCart).toHaveBeenCalledWith(tx, mockUserId);
      expect(mockOrdersRepository.lockVariants).toHaveBeenCalledWith(tx, ['var1', 'var2']);
      expect(mockCartService.getCartOrThrow).toHaveBeenLastCalledWith(mockUserId, tx);
      expect(mockTaxService.findActive).toHaveBeenLastCalledWith(tx);
      expect(mockStoreService.getCurrency).toHaveBeenLastCalledWith(tx);
      const lockedAt = mockOrdersRepository.lockVariants.mock.invocationCallOrder[0];
      const variantReads = mockOrdersRepository.findVariant.mock.invocationCallOrder.slice(-2);
      expect(mockOrdersRepository.lockCart.mock.invocationCallOrder[0]).toBeLessThan(lockedAt);
      expect(variantReads.every((order) => order > lockedAt)).toBe(true);
    });

    it.each([
      [
        'a price',
        () =>
          mockOrdersRepository.findVariant.mockImplementation(async (id: string) => ({
            ...mockVariant,
            id,
            sku: id.toUpperCase(),
            price: new Decimal('11'),
          })),
      ],
      ['the shipping fee', () => mockShippingZonesService.getZoneForCity.mockResolvedValue(zoneWithFee(6))],
      [
        'a tax rate',
        () => mockTaxService.findActive.mockResolvedValue([{ id: 'vat', name: 'VAT', rate: new Decimal('0.1') }]),
      ],
      [
        'the coupon value',
        () => mockPromotionsService.findForPricing.mockResolvedValue(couponFacts('SAVE', 'AMOUNT_OFF', 9)),
      ],
    ])(
      'refuses with CONFLICT QUOTE_CHANGED when %s changed since the quote, reserving and recording nothing',
      async (_case, change) => {
        const params = { ...deliveryParams, couponCode: 'SAVE' };
        const quote = await ordersService.checkoutQuote(mockUserId, params);
        change();

        const error = await ordersService
          .createOrderFromCart(mockUserId, { ...params, quoteHash: quote.quoteHash })
          .catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toMatchObject({ extensions: { reason: 'QUOTE_CHANGED' } });
        expect(mockOrdersRepository.create).not.toHaveBeenCalled();
        expect(mockStockLedger.reserve).not.toHaveBeenCalled();
        expect(mockPromotionsService.reserveRedemptions).not.toHaveBeenCalled();
        expect(mockOrdersRepository.clearCartItems).not.toHaveBeenCalled();
      },
    );

    it('refuses a hash that is not the quote of this cart', async () => {
      await expect(
        ordersService.createOrderFromCart(mockUserId, { ...deliveryParams, quoteHash: 'f'.repeat(64) }),
      ).rejects.toThrow(ConflictException);
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
    });

    it('keeps refusing a coupon that is no longer usable as a bad request, not a quote change', async () => {
      const params = { ...deliveryParams, couponCode: 'SAVE' };
      const quote = await ordersService.checkoutQuote(mockUserId, params);
      mockPromotionsService.findForPricing.mockResolvedValue(
        couponFacts('SAVE', 'AMOUNT_OFF', 10, { isActive: false }),
      );

      await expect(
        ordersService.createOrderFromCart(mockUserId, { ...params, quoteHash: quote.quoteHash }),
      ).rejects.toThrow(new BadRequestException('This coupon is no longer active'));
      expect(mockOrdersRepository.create).not.toHaveBeenCalled();
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

  describe('adminCancelOrder', () => {
    it('cancels through the real cancel path so stock comes back, guarded on goods still in the shop', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: OrderStatus.IN_FULFILMENT });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });
      mockOrdersRepository.hasCapturedPayment.mockResolvedValue(false);

      await ordersService.adminCancelOrder('order1', 'admin1', 'Customer asked by phone');

      expect(mockOrdersRepository.transitionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'order1',
        OrderStatus.CANCELLED,
        [OrderStatus.PLACED, OrderStatus.CONFIRMED, OrderStatus.IN_FULFILMENT],
        {
          actorId: 'admin1',
          reason: 'Customer asked by phone',
          guard: {
            shipments: { every: { status: { in: ['PENDING', 'PICKING', 'PACKED', 'RETURNED', 'CANCELLED'] } } },
          },
        },
      );
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: 'admin1',
        note: 'Order cancelled',
      });
      expect(mockOrdersRepository.cancelOpenShipments).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: 'admin1',
        reason: 'Customer asked by phone',
      });
      expect(mockOrdersRepository.cancelOpenPaymentIntent).toHaveBeenCalledWith(expect.anything(), 'order1');
    });

    it.each([OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.PAYMENT_REVIEW])(
      'refuses to cancel a %s order without writing',
      async (status) => {
        mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status });

        await expect(ordersService.adminCancelOrder('order1', 'admin1')).rejects.toThrow(ConflictException);
        expect(mockOrdersRepository.transitionStatus).not.toHaveBeenCalled();
      },
    );
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
        [OrderStatus.PLACED, OrderStatus.CONFIRMED],
        { actorId: mockUserId, reason: 'Cancelled by the customer', guard: undefined },
      );
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: mockUserId,
        note: 'Order cancelled',
      });
      expect(result.status).toBe('CANCELLED');
    });

    it('should throw ConflictException if order is already shipped', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: 'IN_FULFILMENT' as OrderStatus });

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
    const deliveredOrder = { ...mockOrder, status: OrderStatus.COMPLETED };

    it('should soft-delete a delivered order without moving stock', async () => {
      const deletedOrder = { ...deliveredOrder, deleted: true, deletedAt: new Date() };
      mockOrdersRepository.findById.mockResolvedValue(deliveredOrder);
      mockOrdersRepository.softDelete.mockResolvedValue(deletedOrder);
      mockAuditService.log.mockResolvedValue(undefined);

      const result = await ordersService.deleteOrder('order1', 'admin1');

      expect(ordersRepository.softDelete).toHaveBeenCalledWith(expect.anything(), 'order1', [
        OrderStatus.COMPLETED,
        OrderStatus.CANCELLED,
        OrderStatus.EXPIRED,
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
          'Order "order1" is PLACED; only COMPLETED, CANCELLED, EXPIRED orders can be deleted (cancel it first)',
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

    it('gives the promotion uses back in the same transaction when the order is cancelled', async () => {
      const couponOrder = { ...mockOrder, couponCodeId: 'code1' };
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockOrdersRepository.findById.mockResolvedValue(couponOrder);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...couponOrder, status: OrderStatus.CANCELLED });

      await ordersService.cancelOrder(mockUserId, 'order1');

      expect(mockPromotionsService.releaseRedemptions).toHaveBeenCalledWith(stubTx, 'order1');
    });

    it('keeps the promotion uses of a paid order it cancels (a refund does not give them back)', async () => {
      const stubTx = { id: 'tx' };
      mockOrdersRepository.runTransaction.mockImplementation(async (callback) => callback(stubTx as any));
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, status: OrderStatus.CONFIRMED });
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.CANCELLED });
      mockOrdersRepository.hasCapturedPayment.mockResolvedValue(true);

      await ordersService.adminCancelOrder('order1', 'admin1');

      expect(mockOrdersRepository.hasCapturedPayment).toHaveBeenCalledWith('order1', stubTx);
      expect(mockPromotionsService.releaseRedemptions).not.toHaveBeenCalled();
    });

    it('releases no promotion use when the cancel lost the race to another request', async () => {
      mockOrdersRepository.findById.mockResolvedValue({ ...mockOrder, couponCodeId: 'code1' });
      mockOrdersRepository.transitionStatus.mockResolvedValue(null);

      await expect(ordersService.cancelOrder(mockUserId, 'order1')).rejects.toThrow(ConflictException);
      expect(mockPromotionsService.releaseRedemptions).not.toHaveBeenCalled();
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
          details: { from: OrderStatus.PLACED, to: OrderStatus.CANCELLED },
        },
        stubTx,
      );
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

    it('claims each order (as EXPIRED) only while it still matches the expiry rule, so a restarted payment is not cancelled', async () => {
      mockOrdersRepository.findExpiredPendingOrders.mockResolvedValue([mockOrder]);
      mockOrdersRepository.transitionStatus.mockResolvedValue({ ...mockOrder, status: OrderStatus.EXPIRED });

      await ordersService.expireAbandonedOrders(1);

      const cutoff: Date = mockOrdersRepository.findExpiredPendingOrders.mock.calls[0][0];
      expect(ordersRepository.transitionStatus).toHaveBeenCalledWith(
        expect.anything(),
        'order1',
        OrderStatus.EXPIRED,
        [OrderStatus.PLACED],
        { actorId: undefined, reason: 'Unpaid order expired', guard: abandonedOrderWhere(cutoff) },
      );
      expect(mockStockLedger.releaseOrder).toHaveBeenCalledWith(expect.anything(), 'order1', {
        actorId: undefined,
        note: 'Unpaid order expired',
      });
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
