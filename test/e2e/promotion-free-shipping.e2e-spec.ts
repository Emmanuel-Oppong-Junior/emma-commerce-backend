import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { createCoupon, createPromotion } from '../helpers/promotion.helper';

const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };
const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'ship_pickup' };

// P2-B.6: free shipping is the shipping level, after item and cart promotions; seed zones: Accra 15, Kumasi 30.
describe('Free-shipping promotions (P2-B.6, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let shopperCount = 0;

  /** A customer with one phone (seed_var2, 499.99) in the cart and a delivery address in `city`. */
  const newShopper = async (city: string) => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `ship-${shopperCount}@example.com` } });
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
    });
    const address = await prisma.address.create({
      data: {
        userId: user.id,
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: city === 'Kumasi' ? 'ASHANTI' : 'GREATER_ACCRA',
        street: '1 Ship St',
        city,
        country: 'GH',
      },
    });
    return { userId: user.id, delivery: { fulfillmentType: FulfillmentType.DELIVERY, shippingAddressId: address.id } };
  };
  const shippingOf = (quote: Awaited<ReturnType<OrdersService['checkoutQuote']>>) => ({
    shippingTotal: quote.shippingTotal.toFixed(2),
    adjustments: quote.shippingAdjustments.map((a) => [a.type, a.sourceId, a.amount.toFixed(2)]),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: { id: 'ship_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
  });

  beforeEach(async () => {
    await prisma.promotion.updateMany({ data: { isActive: false } });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('waives the fee in its zone only, stores it as a SHIPPING adjustment and charges exactly the quote', async () => {
    await createPromotion(prisma, {
      id: 'free_accra',
      type: 'FREE_SHIPPING',
      value: null,
      scope: 'CART',
      shippingZones: { connect: [{ id: 'seed_zone_accra' }] },
    } as never);
    const accra = await newShopper('Accra');
    const kumasi = await newShopper('Kumasi');

    const quote = await orders.checkoutQuote(accra.userId, accra.delivery);
    const order = await orders.createOrderFromCart(accra.userId, {
      ...accra.delivery,
      ...contact,
      quoteHash: quote.quoteHash,
    });
    const elsewhere = await orders.checkoutQuote(kumasi.userId, kumasi.delivery);
    const pickedUp = await orders.checkoutQuote(kumasi.userId, pickup);

    expect(shippingOf(quote)).toEqual({ shippingTotal: '0.00', adjustments: [['DISCOUNT', 'free_accra', '-15.00']] });
    expect(quote.discountTotal.toFixed(2)).toBe('0.00');
    expect(order.grandTotal.toFixed(2)).toBe('499.99');
    expect(order.grandTotal.toFixed(2)).toBe(quote.grandTotal.toFixed(2));
    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { adjustments: true } });
    expect(stored.shippingTotal?.toFixed(2)).toBe('0.00');
    expect(stored.discountTotal?.toFixed(2)).toBe('0.00');
    expect(stored.adjustments.map((a) => [a.target, a.orderItemId, a.sourceId, a.amount.toFixed(2)])).toEqual([
      ['SHIPPING', null, 'free_accra', '-15.00'],
    ]);
    expect(await prisma.redemption.count({ where: { orderId: order.id, promotionId: 'free_accra' } })).toBe(1);
    expect(shippingOf(elsewhere)).toEqual({ shippingTotal: '30.00', adjustments: [] });
    expect(shippingOf(pickedUp)).toEqual({ shippingTotal: '0.00', adjustments: [] });
  });

  it('measures its minimum spend after item and cart promotions', async () => {
    await createPromotion(prisma, {
      id: 'free_over_400',
      type: 'FREE_SHIPPING',
      value: null,
      scope: 'CART',
      minimumSpend: 400,
    });
    const shopper = await newShopper('Accra');
    expect(shippingOf(await orders.checkoutQuote(shopper.userId, shopper.delivery)).shippingTotal).toBe('0.00');

    await createPromotion(prisma, { id: 'cart_100', type: 'AMOUNT_OFF', value: 100, scope: 'CART' });

    // 499.99 - 100 = 399.99: below 400 once the cart promotion applies.
    expect(shippingOf(await orders.checkoutQuote(shopper.userId, shopper.delivery))).toEqual({
      shippingTotal: '15.00',
      adjustments: [],
    });
  });

  it('takes a fixed amount off the fee when a coupon code unlocks it, and refuses a zone-limited code elsewhere', async () => {
    const { couponCode } = await createCoupon(prisma, {
      code: 'SHIP10',
      type: 'FREE_SHIPPING',
      value: 10,
      perCustomerLimit: null,
    });
    await createCoupon(prisma, {
      code: 'ACCRASHIP',
      type: 'FREE_SHIPPING',
      value: null,
      perCustomerLimit: null,
      shippingZones: { connect: [{ id: 'seed_zone_accra' }] },
    } as never);
    const kumasi = await newShopper('Kumasi');
    const params = { ...kumasi.delivery, couponCode: 'ship10' };

    const quote = await orders.checkoutQuote(kumasi.userId, params);
    const order = await orders.createOrderFromCart(kumasi.userId, {
      ...params,
      ...contact,
      quoteHash: quote.quoteHash,
    });

    expect(shippingOf(quote)).toEqual({
      shippingTotal: '20.00',
      adjustments: [['COUPON', couponCode.promotionId, '-10.00']],
    });
    expect(order.grandTotal.toFixed(2)).toBe('519.99');
    expect(order.couponCodeId).toBe(couponCode.id);
    expect((await prisma.couponCode.findUniqueOrThrow({ where: { id: couponCode.id } })).usedCount).toBe(1);
    const other = await newShopper('Kumasi');
    await expect(orders.checkoutQuote(other.userId, { ...other.delivery, couponCode: 'accraship' })).rejects.toThrow(
      'This coupon does not cover delivery to your area',
    );
    await expect(orders.checkoutQuote(other.userId, { ...pickup, couponCode: 'accraship' })).resolves.toMatchObject({
      shippingAdjustments: [],
    });
  });

  describe('admin API', () => {
    let managerToken: string;
    const gql = (query: string) => gqlRequest(app, query, undefined, managerToken).expect(200);

    beforeAll(async () => {
      managerToken = await signInAdmin(app);
    });

    it('creates a zone-limited free-shipping promotion and protects its zones from deletion', async () => {
      const created = await gql(
        `mutation { createPromotion(input: {
          name: "Free delivery in Kumasi", scope: CART, type: FREE_SHIPPING, shippingZoneIds: ["seed_zone_ashanti"],
          minimumSpend: "300"
        }) { id type value shippingZoneIds } }`,
      );
      expect(created.body.errors).toBeUndefined();
      expect(created.body.data.createPromotion).toMatchObject({
        type: 'FREE_SHIPPING',
        value: null,
        shippingZoneIds: ['seed_zone_ashanti'],
      });

      const deleteZone = await gql('mutation { deleteShippingZone(id: "seed_zone_ashanti") { id } }');

      expect(deleteZone.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(await prisma.shippingZone.count({ where: { id: 'seed_zone_ashanti' } })).toBe(1);
    });

    it.each([
      ['free shipping on an item scope', 'scope: PRODUCT, type: FREE_SHIPPING', 'CART scope'],
      ['an unknown zone', 'scope: CART, type: FREE_SHIPPING, shippingZoneIds: ["nowhere"]', 'Unknown shipping zone'],
      [
        'zones on a percentage',
        'scope: CART, type: PERCENT, value: "5", shippingZoneIds: ["seed_zone_accra"]',
        'FREE_SHIPPING promotions only',
      ],
    ])('refuses %s with BAD_REQUEST', async (_case, fields, message) => {
      const res = await gql(`mutation { createPromotion(input: { name: "Bad", ${fields} }) { id } }`);

      expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(res.body.errors[0].message).toContain(message);
    });

    it('needs a recent step-up to create free shipping', async () => {
      const redis = app.get<Redis>(REDIS_CLIENT);
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      const res = await gql(
        'mutation { createPromotion(input: { name: "x", scope: CART, type: FREE_SHIPPING }) { id } }',
      );

      expect(res.body.errors[0].extensions.reason).toBe('STEP_UP_REQUIRED');
      managerToken = await signInAdmin(app);
    });
  });
});
