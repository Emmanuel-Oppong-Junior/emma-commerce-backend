import { DiscountService } from '../../src/discount/discount.service';

function discount(id: string, type: 'PERCENTAGE' | 'FLAT', value: number) {
  return { id, name: id, type, value, minimumPurchase: null };
}

function buildDiscountService(repositoryOverrides: Record<string, unknown>) {
  const repository = {
    findProductById: jest.fn().mockResolvedValue({ price: 1000 }),
    findProductWithDiscounts: jest.fn().mockResolvedValue({ discounts: [], categoryId: null }),
    findCategoryDiscounts: jest.fn().mockResolvedValue([]),
    findVariantDiscounts: jest.fn().mockResolvedValue([]),
    updateOrderItem: jest.fn().mockResolvedValue({}),
    updateOrderWithDiscount: jest.fn().mockResolvedValue({}),
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

  it('DISC-01: finalizing discounts on an order that is already PROCESSING does not rewrite its charged total', async () => {
    const order = {
      id: 'order-1',
      status: 'PROCESSING',
      totalAmount: 530,
      items: [{ id: 'item-1', productId: 'product-1', variantId: null, quantity: 1, product: { price: 500 } }],
    };
    const { service, repository } = buildDiscountService({
      findOrderById: jest.fn().mockResolvedValue(order),
      findProductById: jest.fn().mockResolvedValue({ price: 500 }),
    });

    await service.finalizeDiscountsForOrder('order-1').catch(() => undefined);

    expect(repository.updateOrderWithDiscount).not.toHaveBeenCalled();
  });

  it('DISC-01: finalizing a PENDING order keeps the GHS 30 shipping fee in the total', async () => {
    const order = {
      id: 'order-1',
      status: 'PENDING',
      totalAmount: 530,
      items: [{ id: 'item-1', productId: 'product-1', variantId: null, quantity: 1, product: { price: 500 } }],
    };
    const { service, repository } = buildDiscountService({
      findOrderById: jest.fn().mockResolvedValue(order),
      findProductById: jest.fn().mockResolvedValue({ price: 500 }),
    });

    await service.finalizeDiscountsForOrder('order-1');

    const [, totalAmount] = repository.updateOrderWithDiscount.mock.calls[0];
    expect(totalAmount).toBeGreaterThanOrEqual(530);
  });
});
