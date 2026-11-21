import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock, stockOf as ledgerStockOf } from '../helpers/db.helper';
import { quoteHashFor } from '../helpers/checkout.helper';
import { createPromotion } from '../helpers/promotion.helper';

const M = '{ amount currency }';

interface InitializeParams {
  reference: string;
  amount: number;
  currency: string;
}

describe('Checkout pricing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: InitializeParams) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(),
  };

  const activeWindow = () => ({
    isActive: true,
    startsAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endsAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const addToCart = (variantId: string, quantity: number) =>
    gqlRequest(
      app,
      `mutation { addToCart(input: { variantId: "${variantId}", quantity: ${quantity} }) { id } }`,
      undefined,
      userToken,
    ).expect(200);

  const PICKUP = { fulfillmentType: 'PICKUP', pickupLocationId: 'pricing_pickup' } as const;

  const checkoutQuote = async () => {
    const res = await gqlRequest(
      app,
      `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) { subtotal ${M} discountTotal ${M} grandTotal ${M}
        lines { productId unitListPrice ${M} unitDiscount ${M} } } }`,
      { input: PICKUP },
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.checkoutQuote;
  };

  const createPickupOrder = async () =>
    gqlRequest(
      app,
      `mutation { createOrder(input: { fulfillmentType: PICKUP, pickupLocationId: "pricing_pickup", contactEmail: "user@example.com", contactPhone: "+233244000000", quoteHash: "${await quoteHashFor(app, userToken, PICKUP)}" }) {
        id subtotal ${M} discountTotal ${M} shippingTotal ${M} grandTotal ${M}
        items { productId unitListPrice ${M} unitDiscount ${M} lineTotal ${M} quantity }
      } }`,
      undefined,
      userToken,
    ).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: {
        id: 'pricing_pickup',
        name: 'Osu Store',
        address: '12 Oxford St',
        city: 'Accra',
        state: 'Greater Accra',
        country: 'Ghana',
      },
    });
    userToken = await signInUser(app);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.cartItem.deleteMany();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('charges the discounted cart total and asks Paystack for exactly that amount', async () => {
    await createPromotion(prisma, {
      id: 'pricing_pct10',
      name: 'Laptop week',
      type: 'PERCENT',
      value: 10,
      ...activeWindow(),
      targetIds: ['seed_prod1'],
    });
    await addToCart('seed_var1', 2);

    const quote = await checkoutQuote();
    expect(quote).toMatchObject({ subtotal: ghs('1999.98'), discountTotal: ghs('200.00'), grandTotal: ghs('1799.98') });

    const orderRes = await createPickupOrder();
    expect(orderRes.body.errors).toBeUndefined();
    const order = orderRes.body.data.createOrder;
    expect(order).toMatchObject({
      subtotal: ghs('1999.98'),
      discountTotal: ghs('200.00'),
      shippingTotal: ghs('0.00'),
      grandTotal: ghs('1799.98'),
    });
    expect(order.items).toEqual([
      {
        productId: 'seed_prod1',
        unitListPrice: ghs('999.99'),
        unitDiscount: ghs('100.00'),
        lineTotal: ghs('1799.98'),
        quantity: 2,
      },
    ]);
    expect(order.grandTotal).toEqual(quote.grandTotal);

    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId: order.id, paymentMethod: 'card' })
      .expect(201);
    expect(paystack.initializeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 179998, currency: 'GHS' }),
    );
  });

  it('applies whichever of an overlapping product and category discount saves more money', async () => {
    await prisma.category.create({ data: { id: 'pricing_cat', name: 'Kitchen' } });
    await prisma.product.create({
      data: {
        id: 'pricing_kettle',
        name: 'Kettle',
        variants: {
          create: { id: 'pricing_kettle_var', sku: 'PRICING-KETTLE', price: 200, basePrice: 200 },
        },
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: 'pricing_cat',
      },
    });
    await setStock(prisma, 'pricing_kettle_var', 10);
    await createPromotion(prisma, {
      id: 'pricing_flat30',
      name: 'Kettle GHS 30 off',
      type: 'AMOUNT_OFF',
      value: 30,
      ...activeWindow(),
      targetIds: ['pricing_kettle'],
    });
    await createPromotion(prisma, {
      id: 'pricing_cat25',
      name: 'Kitchen 25% off',
      type: 'PERCENT',
      value: 25,
      ...activeWindow(),
      scope: 'CATEGORY',
      targetIds: ['pricing_cat'],
    });
    await addToCart('pricing_kettle_var', 1);

    const quote = await checkoutQuote();
    expect(quote).toMatchObject({ subtotal: ghs('200.00'), discountTotal: ghs('50.00'), grandTotal: ghs('150.00') });

    const orderRes = await createPickupOrder();
    expect(orderRes.body.errors).toBeUndefined();
    expect(orderRes.body.data.createOrder).toMatchObject({ discountTotal: ghs('50.00'), grandTotal: ghs('150.00') });
    const [adjustment] = await prisma.orderAdjustment.findMany({
      where: { orderId: orderRes.body.data.createOrder.id },
    });
    expect(adjustment).toMatchObject({ type: 'DISCOUNT', sourceId: 'pricing_cat25' });
  });

  it('no longer offers finalizeOrder', async () => {
    const res = await gqlRequest(app, `mutation { finalizeOrder(id: "any") { id } }`, undefined, userToken).expect(400);

    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  describe('products with variants', () => {
    beforeAll(async () => {
      await prisma.product.create({
        data: {
          id: 'pricing_shirt',
          name: 'Linen Shirt',
          images: [],
          isActive: true,
          status: 'PUBLISHED',
          variants: {
            create: [
              {
                id: 'pricing_shirt_s',
                optionValues: { size: 'S' },
                optionsKey: 'size=s',
                price: 150,
                basePrice: 150,
                sku: 'CHECKOUT-S',
              },
              {
                id: 'pricing_shirt_m',
                optionValues: { size: 'M' },
                optionsKey: 'size=m',
                price: 180,
                basePrice: 180,
                sku: 'CHECKOUT-M',
              },
            ],
          },
        },
      });
      await setStock(prisma, 'pricing_shirt_s', 20);
      await setStock(prisma, 'pricing_shirt_m', 5);
    });

    const stockOf = async (variantId: string) => (await ledgerStockOf(prisma, variantId)).available;

    it('adds the chosen variant of a product with several variants to the cart at that variant’s price', async () => {
      const res = await addToCart('pricing_shirt_m', 1);

      expect(res.body.errors).toBeUndefined();
      const quote = await checkoutQuote();
      expect(quote.lines).toHaveLength(1);
      expect(quote.lines[0]).toMatchObject({ productId: 'pricing_shirt', unitListPrice: ghs('180.00') });
      expect(await prisma.cartItem.count({ where: { variantId: 'pricing_shirt_m' } })).toBe(1);
      expect(await prisma.cartItem.count({ where: { variantId: 'pricing_shirt_s' } })).toBe(0);
    });

    it('checks out a cart holding one variant of a product with several, taking stock from that variant only', async () => {
      const cart = await prisma.cart.upsert({
        where: { userId: 'seed_user' },
        create: { userId: 'seed_user' },
        update: {},
      });
      await prisma.cartItem.createMany({
        data: [
          { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
          { cartId: cart.id, productId: 'pricing_shirt', variantId: 'pricing_shirt_m', quantity: 1 },
        ],
      });
      const phoneBefore = await stockOf('seed_var2');

      const res = await createPickupOrder();

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.createOrder).toMatchObject({ grandTotal: ghs('679.99') });
      expect(await stockOf('pricing_shirt_m')).toBe(4);
      expect(await stockOf('pricing_shirt_s')).toBe(20);
      expect(await stockOf('seed_var2')).toBe(phoneBefore - 1);
      const shirtLine = await prisma.orderItem.findFirstOrThrow({
        where: { orderId: res.body.data.createOrder.id, productId: 'pricing_shirt' },
      });
      expect(shirtLine).toMatchObject({ variantId: 'pricing_shirt_m', sku: 'CHECKOUT-M', quantity: 1 });
      expect(shirtLine.unitListPrice.sub(shirtLine.unitDiscount).toFixed(2)).toBe('180.00');
    });

    it('still sells a product with a single default variant', async () => {
      await addToCart('seed_var2', 1);

      const res = await createPickupOrder();

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.createOrder).toMatchObject({ grandTotal: ghs('499.99') });
    });
  });
});
