import { INestApplication } from '@nestjs/common';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PRICING_VERSION } from '../../src/pricing/price';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { createCoupon, createPromotion } from '../helpers/promotion.helper';

const USER = 'seed_user';
const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'stacking_pickup' };
const contact = { contactEmail: 'user@example.com', contactPhone: '+233244000000' };

// P2-B.2 through the real checkout: the promotions are read from Postgres and priced by checkoutQuote, and the order
// charges exactly that quote.
describe('Promotion stacking through checkoutQuote and createOrder (P2-B.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;

  const fillCart = async (items: [string, string, number][]) => {
    const cart = await prisma.cart.upsert({ where: { userId: USER }, create: { userId: USER }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    for (const [productId, variantId, quantity] of items) {
      await prisma.cartItem.create({ data: { cartId: cart.id, productId, variantId, quantity } });
    }
  };
  const sources = (quote: Awaited<ReturnType<OrdersService['checkoutQuote']>>) => ({
    lines: quote.lines.map((line) => line.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])),
    cart: quote.adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)]),
    grandTotal: quote.grandTotal.toFixed(2),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: {
        id: 'stacking_pickup',
        name: 'Osu',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'Ghana',
      },
    });
  });

  beforeEach(async () => {
    await prisma.redemption.deleteMany();
    await prisma.promotion.deleteMany();
    await fillCart([
      ['seed_prod1', 'seed_var1', 1],
      ['seed_prod2', 'seed_var2', 2],
    ]);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('stacks the best promotion of each group and charges that quote', async () => {
    await createPromotion(prisma, {
      id: 'sale10',
      type: 'PERCENT',
      value: 10,
      targetIds: ['seed_prod1'],
      stackingGroup: 'sale',
    });
    await createPromotion(prisma, {
      id: 'sale50off',
      type: 'AMOUNT_OFF',
      value: 50,
      targetIds: ['seed_prod1'],
      stackingGroup: 'sale',
    });
    await createPromotion(prisma, {
      id: 'brand20',
      type: 'AMOUNT_OFF',
      value: 20,
      scope: 'SKU',
      targetIds: ['seed_var1'],
      stackingGroup: 'loyalty',
      priority: -1,
    });

    const quote = await orders.checkoutQuote(USER, pickup);
    const order = await orders.createOrderFromCart(USER, { ...pickup, ...contact, quoteHash: quote.quoteHash });

    // 999.99: loyalty 20 first (priority -1), then the sale group's best on what is left: 10% of 979.99 = 98.00.
    expect(sources(quote)).toEqual({
      lines: [
        [
          ['brand20', '-20.00'],
          ['sale10', '-98.00'],
        ],
        [],
      ],
      cart: [],
      grandTotal: '1881.97',
    });
    expect(order.grandTotal.toFixed(2)).toBe('1881.97');
    expect(order.pricingVersion).toBe(PRICING_VERSION);
    expect(
      (await prisma.redemption.findMany({ where: { orderId: order.id }, orderBy: { promotionId: 'asc' } })).map(
        (r) => r.promotionId,
      ),
    ).toEqual(['brand20', 'sale10']);
  });

  it('lets an exclusive promotion block the others, the coupon included, and records only its redemption', async () => {
    await createPromotion(prisma, {
      id: 'sale10',
      type: 'PERCENT',
      value: 10,
      targetIds: ['seed_prod1', 'seed_prod2'],
    });
    await createPromotion(prisma, { id: 'vip', type: 'AMOUNT_OFF', value: 150, scope: 'CART', exclusive: true });
    await createCoupon(prisma, { code: 'STACK5', type: 'AMOUNT_OFF', value: 5 });

    const quote = await orders.checkoutQuote(USER, { ...pickup, couponCode: 'stack5' });
    const order = await orders.createOrderFromCart(USER, {
      ...pickup,
      ...contact,
      couponCode: 'stack5',
      quoteHash: quote.quoteHash,
    });

    expect(sources(quote)).toEqual({ lines: [[], []], cart: [['vip', '-150.00']], grandTotal: '1849.97' });
    expect(order.couponCodeId).toBeNull();
    expect((await prisma.redemption.findMany({ where: { orderId: order.id } })).map((r) => r.promotionId)).toEqual([
      'vip',
    ]);
  });

  it('measures a cart minimum spend on the subtotal after item promotions', async () => {
    // List 1999.97; after 10% off the phones (2 x 50.00) it is 1899.97.
    await createPromotion(prisma, { id: 'phones10', type: 'PERCENT', value: 10, targetIds: ['seed_prod2'] });
    await createPromotion(prisma, {
      id: 'spend1900',
      type: 'AMOUNT_OFF',
      value: 25,
      scope: 'CART',
      minimumSpend: 1900,
    });
    await createPromotion(prisma, {
      id: 'spend1800',
      type: 'AMOUNT_OFF',
      value: 15,
      scope: 'CART',
      minimumSpend: 1800,
      stackingGroup: 'other',
    });

    const quote = await orders.checkoutQuote(USER, pickup);

    expect(sources(quote).cart).toEqual([['spend1800', '-15.00']]);
    expect(quote.grandTotal.toFixed(2)).toBe('1884.97');
  });
});
