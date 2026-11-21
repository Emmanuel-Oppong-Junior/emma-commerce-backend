import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '../../src/generated/prisma/client';
import { PromotionsService } from '../../src/promotions/promotions.service';
import { OrdersService } from '../../src/order/order.service';
import { price } from '../../src/pricing/price';

const IN_DATE = { startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) };

/** An automatic promotion as the database returns it, with its targets. */
function discount(id: string, type: 'PERCENTAGE' | 'FLAT', value: number, targets: { variantIds?: string[] } = {}) {
  return {
    id,
    name: id,
    description: null,
    scope: targets.variantIds ? 'SKU' : 'PRODUCT',
    type: type === 'PERCENTAGE' ? 'PERCENT' : 'AMOUNT_OFF',
    value: new Prisma.Decimal(value),
    minimumSpend: null,
    minimumQuantity: null,
    isActive: true,
    priority: 0,
    stackingGroup: 'default',
    exclusive: false,
    requiresCoupon: false,
    usageLimit: null,
    usedCount: 0,
    perCustomerLimit: null,
    createdAt: new Date(0),
    ...IN_DATE,
    variants: (targets.variantIds ?? []).map((variantId) => ({ id: variantId })),
    products: targets.variantIds ? [] : [{ id: 'product-1' }],
    categories: [],
    brands: [],
    customerGroups: [],
    firstOrderOnly: false,
  };
}

function onProduct(...discounts: ReturnType<typeof discount>[]) {
  return discounts;
}

/** The PromotionsService finding `discounts` as the candidates of any cart. */
function promotionsFinding(discounts: ReturnType<typeof discount>[]) {
  const repository = {
    findCandidates: jest.fn().mockResolvedValue(discounts),
    countReservedByPromotion: jest.fn().mockResolvedValue({}),
    findCustomerGroupIds: jest.fn().mockResolvedValue([]),
    hasPriorOrder: jest.fn().mockResolvedValue(false),
  };
  return new PromotionsService(repository as never, {} as never);
}

/** Prices one unit of variant-1 (of product-1) at `price` with the promotions the PromotionsService finds for it. */
async function priceOneUnit(unitPrice: number, discounts: ReturnType<typeof onProduct>) {
  const now = new Date();
  const { promotions, customer } = await promotionsFinding(discounts).findForPricing(
    { variantIds: ['variant-1'], productIds: ['product-1'], categoryIds: [], brandIds: [] },
    'user-1',
    undefined,
    now,
  );
  const line = {
    variantId: 'variant-1',
    productId: 'product-1',
    categoryId: null,
    brandId: null,
    quantity: 1,
    taxable: false,
  };
  const quote = price(
    { lines: [{ ...line, unitListPrice: new Prisma.Decimal(unitPrice) }], shippingFee: new Prisma.Decimal(0) },
    { currency: 'GHS', now, promotions, taxRates: [], customer },
  );
  const [priced] = quote.lines;
  return { unitDiscount: priced.unitDiscount, discountedUnitPrice: priced.unitListPrice.sub(priced.unitDiscount) };
}

describe('Discounts (audit repro: DISC-01, DISC-02)', () => {
  it('DISC-02: the best discount is the one that saves the customer the most money (30% beats GHS 50 off on GHS 1,000)', async () => {
    const result = await priceOneUnit(
      1000,
      onProduct(discount('flat-50', 'FLAT', 50), discount('pct-30', 'PERCENTAGE', 30)),
    );

    expect(result.unitDiscount.toFixed(2)).toBe('300.00');
    expect(result.discountedUnitPrice.toFixed(2)).toBe('700.00');
  });

  it('DISC-02: a GHS 8 flat discount beats 10% on a GHS 50 item', async () => {
    const result = await priceOneUnit(
      50,
      onProduct(discount('pct-10', 'PERCENTAGE', 10), discount('flat-8', 'FLAT', 8)),
    );

    expect(result.unitDiscount.toFixed(2)).toBe('8.00');
  });

  it('DISC-01: the API has no client-callable mutation that re-prices an existing order', () => {
    const schema = readFileSync(join(__dirname, '../../schema.gql'), 'utf8');

    expect(schema).not.toMatch(/\bfinalizeOrder\(/);
  });

  it('DISC-01: createOrder charges the discounted price and keeps the GHS 30 shipping fee', async () => {
    const variant = {
      id: 'variant-1',
      productId: 'product-1',
      sku: 'KETTLE',
      optionValues: {},
      price: new Prisma.Decimal(500),
      stockLevels: [{ onHand: 5, reserved: 0 }],
      isActive: true,
      product: {
        id: 'product-1',
        name: 'Kettle',
        currency: 'GHS',
        isActive: true,
        status: 'PUBLISHED',
        categoryId: null,
        brandId: null,
      },
    };
    const repository = {
      findUserById: jest.fn().mockResolvedValue({ id: 'user-1', isActive: true }),
      findAddressForUser: jest.fn().mockResolvedValue({
        city: 'Accra',
        region: 'GREATER_ACCRA',
        recipientName: 'Ama Mensah',
        phone: '+233244123456',
      }),
      findVariant: jest.fn().mockResolvedValue(variant),
      runTransaction: jest.fn((work: (tx: unknown) => unknown) => work({})),
      lockSellableVariant: jest.fn().mockResolvedValue(true),
      lockCart: jest.fn(),
      lockVariants: jest.fn(),
      create: jest.fn().mockImplementation((_tx, _userId, details) => ({ id: 'order-1', ...details, items: [] })),
      clearCartItems: jest.fn(),
    };
    const cart = { id: 'cart-1', items: [{ productId: 'product-1', variantId: 'variant-1', quantity: 1 }] };
    const promotions = promotionsFinding([discount('pct-10', 'PERCENTAGE', 10, { variantIds: ['variant-1'] })]);
    jest.spyOn(promotions, 'reserveRedemptions').mockResolvedValue();
    const service = new OrdersService(
      repository as never,
      { getCartOrThrow: jest.fn().mockResolvedValue(cart) } as never,
      {} as never,
      { reserve: jest.fn().mockResolvedValue(true) } as never,
      { record: jest.fn() } as never,
      { getFeeForCity: jest.fn().mockResolvedValue(new Prisma.Decimal(30)) } as never,
      {} as never,
      {} as never,
      promotions,
      { getCurrency: jest.fn().mockResolvedValue('GHS') } as never,
      { findActive: jest.fn().mockResolvedValue([]) } as never,
    );

    const params = {
      fulfillmentType: 'DELIVERY',
      shippingAddressId: 'address-1',
      contactEmail: 'customer@test.local',
      contactPhone: '+233200000000',
    } as const;
    const { quoteHash } = await service.checkoutQuote('user-1', params);
    await service.createOrderFromCart('user-1', { ...params, quoteHash });

    const [, , details] = repository.create.mock.calls[0];
    expect(Number(details.snapshot.grandTotal)).toBe(480);
  });
});
