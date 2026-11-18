import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma } from '../../src/generated/prisma/client';
import { DiscountService } from '../../src/discount/discount.service';
import { OrdersService } from '../../src/order/order.service';

function discount(id: string, type: 'PERCENTAGE' | 'FLAT', value: number) {
  return { id, name: id, type, value, minimumPurchase: null };
}

function buildDiscountService(repositoryOverrides: Record<string, unknown>) {
  const repository = {
    findProductById: jest.fn().mockResolvedValue({ price: 1000 }),
    findProductWithDiscounts: jest.fn().mockResolvedValue({ discounts: [], categoryId: null }),
    findCategoryDiscounts: jest.fn().mockResolvedValue([]),
    findVariantDiscounts: jest.fn().mockResolvedValue([]),
    ...repositoryOverrides,
  };
  const service = new DiscountService(
    repository as never,
    { get: jest.fn(), set: jest.fn(), del: jest.fn() } as never,
    {} as never,
  );
  return { service, repository };
}

describe('Discounts (audit repro: DISC-01, DISC-02)', () => {
  it('DISC-02: the best discount is the one that saves the customer the most money (30% beats GHS 50 off on GHS 1,000)', async () => {
    const { service } = buildDiscountService({
      findProductWithDiscounts: jest.fn().mockResolvedValue({
        discounts: [discount('flat-50', 'FLAT', 50), discount('pct-30', 'PERCENTAGE', 30)],
        categoryId: null,
      }),
    });

    const result = await service.getDiscountedPriceForProduct('product-1');

    expect(result.discountAmount).toBe(300);
    expect(result.discountedPrice).toBe(700);
  });

  it('DISC-02: a GHS 8 flat discount beats 10% on a GHS 50 item', async () => {
    const { service } = buildDiscountService({
      findProductById: jest.fn().mockResolvedValue({ price: 50 }),
      findProductWithDiscounts: jest.fn().mockResolvedValue({
        discounts: [discount('pct-10', 'PERCENTAGE', 10), discount('flat-8', 'FLAT', 8)],
        categoryId: null,
      }),
    });

    const result = await service.getDiscountedPriceForProduct('product-1');

    expect(result.discountAmount).toBe(8);
  });

  it('DISC-01: the API has no client-callable mutation that re-prices an existing order', () => {
    const schema = readFileSync(join(__dirname, '../../schema.gql'), 'utf8');

    expect(schema).not.toMatch(/\bfinalizeOrder\(/);
  });

  it('DISC-01: createOrder charges the discounted price and keeps the GHS 30 shipping fee', async () => {
    const product = { id: 'product-1', name: 'Kettle', price: 500, currency: 'GHS', quantity: 5, categoryId: null };
    const repository = {
      findUserById: jest.fn().mockResolvedValue({ id: 'user-1', isActive: true }),
      findAddressForUser: jest.fn().mockResolvedValue({ city: 'Accra' }),
      findProductById: jest.fn().mockResolvedValue(product),
      runTransaction: jest.fn((work: (tx: unknown) => unknown) => work({})),
      decrementProductStock: jest.fn().mockResolvedValue({ ...product, quantity: 4 }),
      create: jest.fn().mockImplementation((_tx, _userId, details) => ({ id: 'order-1', ...details, items: [] })),
      clearCartItems: jest.fn(),
      findNamesOfProductsWithVariants: jest.fn().mockResolvedValue([]),
    };
    const cart = { id: 'cart-1', items: [{ productId: 'product-1', quantity: 1 }] };
    const discounts = {
      findActiveDiscountsByProduct: jest
        .fn()
        .mockResolvedValue(new Map([['product-1', [discount('pct-10', 'PERCENTAGE', 10)]]])),
    };
    const service = new OrdersService(
      repository as never,
      { getCartOrThrow: jest.fn().mockResolvedValue(cart) } as never,
      {} as never,
      {} as never,
      { logInventoryChange: jest.fn() } as never,
      {} as never,
      { getFeeForCity: jest.fn().mockResolvedValue(new Prisma.Decimal(30)) } as never,
      {} as never,
      {} as never,
      discounts as never,
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
