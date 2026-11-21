import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Prisma } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock, stockOf } from '../helpers/db.helper';

const M = '{ amount currency }';
const sum = (values: string[]) => values.reduce((total, value) => total.add(value), new Prisma.Decimal(0)).toFixed(2);

interface Quote {
  quoteHash: string;
  subtotal: { amount: string };
  discountTotal: { amount: string };
  taxTotal: { amount: string };
  shippingTotal: { amount: string };
  grandTotal: { amount: string };
  lines: { cartItemId: string; variantId: string; lineTotal: { amount: string } }[];
  adjustments: {
    type: string;
    code: string;
    amount: { amount: string };
    allocations: { cartItemId: string; amount: { amount: string } }[];
  }[];
}

// P2-A.2 accept criteria: the quote shown is the amount charged, and createOrder re-prices inside its transaction.
describe('Checkout quote and the quote hash on createOrder (P2-A.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let addressId: string;
  /** A fresh coupon per test: a customer can use a coupon once. */
  let couponCode: string;
  let couponCount = 0;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(),
  };

  const gql = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, userToken).expect(200);

  const delivery = (couponCode?: string) => ({
    fulfillmentType: 'DELIVERY',
    shippingAddressId: addressId,
    ...(couponCode && { couponCode }),
  });

  const quote = async (input: Record<string, unknown>): Promise<Quote> => {
    const res = await gql(
      `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) {
        quoteHash currency pricingVersion subtotal ${M} discountTotal ${M} taxTotal ${M} shippingTotal ${M} grandTotal ${M}
        lines { cartItemId variantId sku quantity unitListPrice ${M} unitDiscount ${M} unitNet ${M} unitTax ${M} lineTotal ${M}
          adjustments { type sourceId amount ${M} } taxLines { name rate base ${M} amount ${M} } }
        adjustments { type sourceId code amount ${M} allocations { cartItemId amount ${M} } }
      } }`,
      { input },
    );
    expect(res.body.errors).toBeUndefined();
    return res.body.data.checkoutQuote;
  };

  const createOrder = (input: Record<string, unknown>) =>
    gql(
      `mutation($input: CreateOrderInput!) { createOrder(input: $input) {
        id subtotal ${M} discountTotal ${M} taxTotal ${M} shippingTotal ${M} grandTotal ${M}
        adjustments { type orderItemId amount ${M} }
      } }`,
      { input: { contactEmail: 'user@example.com', contactPhone: '+233244000000', ...input } },
    );

  const fillCart = async () => {
    await prisma.cartItem.deleteMany();
    for (const [variantId, quantity] of [
      ['quote_kente_var', 2],
      ['seed_var2', 1],
    ] as const) {
      const res = await gql(
        `mutation { addToCart(input: { variantId: "${variantId}", quantity: ${quantity} }) { id } }`,
      );
      expect(res.body.errors).toBeUndefined();
    }
  };

  const placementState = async () => ({
    orders: await prisma.order.count(),
    reservations: await prisma.stockReservation.count(),
    couponUses: await prisma.couponUsage.count(),
    couponUsedCount: (await prisma.coupon.findUniqueOrThrow({ where: { code: couponCode } })).usedCount,
    cartItems: await prisma.cartItem.count(),
    kente: await stockOf(prisma, 'quote_kente_var'),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Quote St',
        city: 'Accra',
        country: 'GH',
      },
    });
    addressId = address.id;
    // A taxable product priced the way the catalogue prices it: basePrice 100 x (1 + 0.175) = 117.50.
    await prisma.product.create({
      data: {
        id: 'quote_kente',
        name: 'Kente cloth',
        images: [],
        isActive: true,
        isTaxable: true,
        status: 'PUBLISHED',
        variants: {
          create: [{ id: 'quote_kente_var', sku: 'KENTE-QUOTE', optionsKey: '', price: '117.50', basePrice: 100 }],
        },
      },
    });
    await setStock(prisma, 'quote_kente_var', 1000);
  });

  beforeEach(async () => {
    await prisma.shippingZone.update({ where: { id: 'seed_zone_accra' }, data: { fee: 15 } });
    await prisma.variant.update({ where: { id: 'quote_kente_var' }, data: { price: '117.50' } });
    await prisma.tax.deleteMany();
    await prisma.tax.createMany({
      data: [
        { id: 'quote_vat', name: 'VAT', rate: '0.15' },
        { id: 'quote_nhil', name: 'NHIL', rate: '0.025' },
      ],
    });
    await prisma.discount.upsert({
      where: { id: 'quote_disc10' },
      create: {
        id: 'quote_disc10',
        name: 'Kente week',
        type: 'PERCENTAGE',
        value: 10,
        isActive: true,
        startDate: new Date(Date.now() - 86_400_000),
        endDate: new Date(Date.now() + 86_400_000),
        products: { connect: { id: 'quote_kente' } },
      },
      update: { value: 10 },
    });
    couponCount += 1;
    couponCode = `QUOTE20-${couponCount}`;
    await prisma.coupon.create({ data: { code: couponCode, discountType: 'FLAT', value: 20 } });
    await fillCart();
    paystack.initializeTransaction.mockClear();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('quotes discount, coupon, tax and shipping, writes nothing, and createOrder charges exactly the quote', async () => {
    const ordersBefore = await prisma.order.count();
    const quoted = await quote(delivery(couponCode));

    // 117.50 - 11.75 = 105.75 a unit (15.75 tax in it); the phone has no tax. 211.50 + 499.99 - 20 + 15.
    expect(quoted).toMatchObject({
      currency: 'GHS',
      pricingVersion: 1,
      subtotal: ghs('734.99'),
      discountTotal: ghs('43.50'),
      taxTotal: ghs('31.50'),
      shippingTotal: ghs('15.00'),
      grandTotal: ghs('706.49'),
    });
    const [coupon] = quoted.adjustments;
    expect(coupon).toMatchObject({ type: 'COUPON', code: couponCode, amount: ghs('-20.00') });
    expect(sum(coupon.allocations.map((a) => a.amount.amount))).toBe('-20.00');
    expect(coupon.allocations.map((a) => a.cartItemId).sort()).toEqual(quoted.lines.map((l) => l.cartItemId).sort());
    expect(await prisma.order.count()).toBe(ordersBefore);
    expect(await prisma.cartItem.count()).toBe(2);

    const placed = await createOrder({ ...delivery(couponCode), quoteHash: quoted.quoteHash });

    expect(placed.body.errors).toBeUndefined();
    const order = placed.body.data.createOrder;
    for (const field of ['subtotal', 'discountTotal', 'taxTotal', 'shippingTotal', 'grandTotal'] as const) {
      expect(order[field]).toEqual(quoted[field]);
    }
    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId: order.id, paymentMethod: 'card' })
      .expect(201);
    expect(paystack.initializeTransaction).toHaveBeenLastCalledWith(
      expect.objectContaining({ amount: 70649, currency: 'GHS' }),
    );
  });

  it('still reserves the stock and records the coupon use on placement, exactly as before', async () => {
    const kenteBefore = await stockOf(prisma, 'quote_kente_var');
    const quoted = await quote(delivery(couponCode));

    const placed = await createOrder({ ...delivery(couponCode), quoteHash: quoted.quoteHash });

    const orderId = placed.body.data.createOrder.id;
    expect(await stockOf(prisma, 'quote_kente_var')).toEqual({
      onHand: kenteBefore.onHand,
      reserved: kenteBefore.reserved + 2,
      available: kenteBefore.available - 2,
    });
    expect(await prisma.stockReservation.count({ where: { orderId, status: 'ACTIVE' } })).toBe(2);
    expect(await prisma.couponUsage.findMany({ where: { orderId } })).toHaveLength(1);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: couponCode } })).usedCount).toBe(1);
    expect(await prisma.cartItem.count()).toBe(0);
  });

  it.each([
    ['a price', () => prisma.variant.update({ where: { id: 'quote_kente_var' }, data: { price: '118.00' } })],
    ['a discount', () => prisma.discount.update({ where: { id: 'quote_disc10' }, data: { value: 15 } })],
    ['a tax rate', () => prisma.tax.update({ where: { id: 'quote_vat' }, data: { rate: '0.16' } })],
    ['the shipping fee', () => prisma.shippingZone.update({ where: { id: 'seed_zone_accra' }, data: { fee: 20 } })],
    ['the coupon (stale)', () => prisma.coupon.update({ where: { code: couponCode }, data: { value: 25 } })],
  ])(
    'refuses with CONFLICT QUOTE_CHANGED when %s changed after the quote, placing, reserving and recording nothing',
    async (_case, change) => {
      const quoted = await quote(delivery(couponCode));
      await change();
      const before = await placementState();

      const res = await createOrder({ ...delivery(couponCode), quoteHash: quoted.quoteHash });

      expect(res.body.errors[0].extensions).toMatchObject({ code: 'CONFLICT', reason: 'QUOTE_CHANGED' });
      expect(await placementState()).toEqual(before);
      const requoted = await quote(delivery(couponCode));
      expect(requoted.quoteHash).not.toBe(quoted.quoteHash);
      expect(
        (await createOrder({ ...delivery(couponCode), quoteHash: requoted.quoteHash })).body.errors,
      ).toBeUndefined();
    },
  );

  it('keeps refusing a coupon that can no longer be used as BAD_REQUEST, recording nothing', async () => {
    const quoted = await quote(delivery(couponCode));
    await prisma.coupon.update({ where: { code: couponCode }, data: { isActive: false } });
    const before = await placementState();

    const res = await createOrder({ ...delivery(couponCode), quoteHash: quoted.quoteHash });

    expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(res.body.errors[0].message).toBe('This coupon is no longer active');
    expect(await placementState()).toEqual(before);
  });

  it('refuses a quote for another fulfilment or coupon', async () => {
    const withoutCoupon = await quote(delivery());
    const before = await placementState();

    const res = await createOrder({ ...delivery(couponCode), quoteHash: withoutCoupon.quoteHash });

    expect(res.body.errors[0].extensions).toMatchObject({ code: 'CONFLICT', reason: 'QUOTE_CHANGED' });
    expect(await placementState()).toEqual(before);
  });

  it('requires quoteHash: a missing one fails schema validation, an empty or malformed one is BAD_USER_INPUT', async () => {
    const before = await placementState();
    // quoteHash is String!: without it the operation is refused before it runs.
    const missing = await gqlRequest(
      app,
      `mutation { createOrder(input: { fulfillmentType: DELIVERY, shippingAddressId: "${addressId}",
        contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id } }`,
      undefined,
      userToken,
    ).expect(400);
    const empty = await createOrder({ ...delivery(), quoteHash: '' });
    const malformed = await createOrder({ ...delivery(), quoteHash: 'not-a-hash' });

    expect(missing.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
    expect(missing.body.errors[0].message).toContain('quoteHash');
    expect(empty.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(malformed.body.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(await placementState()).toEqual(before);
  });

  it('places one order when the same quote is submitted twice at once', async () => {
    const quoted = await quote(delivery());
    const before = await placementState();

    const results = await Promise.all([
      createOrder({ ...delivery(), quoteHash: quoted.quoteHash }),
      createOrder({ ...delivery(), quoteHash: quoted.quoteHash }),
    ]);

    expect(results.filter((res) => !res.body.errors)).toHaveLength(1);
    expect(results.find((res) => res.body.errors)!.body.errors[0].extensions.code).toBe('NOT_FOUND');
    expect(await prisma.order.count()).toBe(before.orders + 1);
    expect(await prisma.stockReservation.count()).toBe(before.reservations + 2);
  });

  it('quotes pickup without shipping', async () => {
    await prisma.pickupLocation.upsert({
      where: { id: 'quote_pickup' },
      create: { id: 'quote_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
      update: {},
    });

    const pickup = await quote({ fulfillmentType: 'PICKUP', pickupLocationId: 'quote_pickup' });
    const placed = await createOrder({
      fulfillmentType: 'PICKUP',
      pickupLocationId: 'quote_pickup',
      quoteHash: pickup.quoteHash,
    });

    expect(pickup).toMatchObject({ shippingTotal: ghs('0.00'), grandTotal: ghs('711.49') });
    expect(placed.body.data.createOrder.grandTotal).toEqual(ghs('711.49'));
  });

  it('no longer offers cartWithDiscount', async () => {
    const res = await gqlRequest(app, `query { cartWithDiscount { id } }`, undefined, userToken).expect(400);

    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
