import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '../../src/generated/prisma/client';
import { DiscountService } from '../../src/discount/discount.service';
import { OrdersService } from '../../src/order/order.service';
import { priceCart } from '../../src/discount/pricing';

function discount(id: string, type: 'PERCENTAGE' | 'FLAT', value: number) {
  return { id, name: id, type, value, minimumPurchase: null };
}

function onProduct(...discounts: ReturnType<typeof discount>[]) {
  return discounts.map((d) => ({ ...d, products: [{ id: 'product-1' }], categories: [] }));
}

/** Prices one unit of variant-1 (of product-1) at `price` with the discounts the DiscountService finds for it. */
async function priceOneUnit(price: number, discounts: ReturnType<typeof onProduct>) {
  const repository = { findActiveDiscountsFor: jest.fn().mockResolvedValue(discounts) };
  const service = new DiscountService(
    repository as never,
    { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
    {} as never,
  );
  const candidates = await service.findActiveDiscountsByVariant([
    { id: 'variant-1', productId: 'product-1', categoryId: null, discountId: null },
  ]);
  return priceCart([{ variantId: 'variant-1', productId: 'product-1', unitPrice: price, quantity: 1 }], candidates)
    .lines[0];
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
      price: 500,
      stockLevels: [{ onHand: 5, reserved: 0 }],
      isActive: true,
      discountId: null,
      product: {
        id: 'product-1',
        name: 'Kettle',
        currency: 'GHS',
        isActive: true,
        status: 'PUBLISHED',
        categoryId: null,
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
      create: jest.fn().mockImplementation((_tx, _userId, details) => ({ id: 'order-1', ...details, items: [] })),
      clearCartItems: jest.fn(),
    };
    const cart = { id: 'cart-1', items: [{ productId: 'product-1', variantId: 'variant-1', quantity: 1 }] };
    const discounts = {
      findActiveDiscountsByVariant: jest
        .fn()
        .mockResolvedValue(new Map([['variant-1', [discount('pct-10', 'PERCENTAGE', 10)]]])),
    };
    const service = new OrdersService(
      repository as never,
      { getCartOrThrow: jest.fn().mockResolvedValue(cart) } as never,
      {} as never,
      {} as never,
      { reserve: jest.fn().mockResolvedValue(true) } as never,
      { record: jest.fn() } as never,
      { getFeeForCity: jest.fn().mockResolvedValue(new Prisma.Decimal(30)) } as never,
      {} as never,
      {} as never,
      discounts as never,
      { getCurrency: jest.fn().mockResolvedValue('GHS') } as never,
    );

    await service.createOrderFromCart('user-1', {
      fulfillmentType: 'DELIVERY',
      shippingAddressId: 'address-1',
      contactEmail: 'customer@test.local',
      contactPhone: '+233200000000',
    });

    const [, , details] = repository.create.mock.calls[0];
    expect(Number(details.totalAmount)).toBe(480);
  });
});
