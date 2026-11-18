import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';

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
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });

  const addToCart = (productId: string, quantity: number) =>
    gqlRequest(
      app,
      `mutation { addToCart(input: { productId: "${productId}", quantity: ${quantity} }) { id } }`,
      undefined,
      userToken,
    ).expect(200);

  const cartWithDiscount = async () => {
    const res = await gqlRequest(
      app,
      `query { cartWithDiscount { total discountTotal finalTotal items { productId originalPrice discountedPrice } } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.cartWithDiscount;
  };

  const createPickupOrder = () =>
    gqlRequest(
      app,
      `mutation { createOrder(input: { fulfillmentType: PICKUP, pickupLocationId: "pricing_pickup", contactEmail: "user@example.com", contactPhone: "+233244000000" }) {
        id subtotal discountTotal shippingFee totalAmount
        items { productId originalPrice discountAmount priceAtOrder quantity }
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
    await prisma.discount.create({
      data: {
        id: 'pricing_pct10',
        name: 'Laptop week',
        type: 'PERCENTAGE',
        value: 10,
        ...activeWindow(),
        products: { connect: { id: 'seed_prod1' } },
      },
    });
    await addToCart('seed_prod1', 2);

    const cart = await cartWithDiscount();
    expect(cart).toMatchObject({ total: 1999.98, discountTotal: 200, finalTotal: 1799.98 });

    const orderRes = await createPickupOrder();
    expect(orderRes.body.errors).toBeUndefined();
    const order = orderRes.body.data.createOrder;
    expect(order).toMatchObject({ subtotal: 1799.98, discountTotal: 200, shippingFee: 0, totalAmount: 1799.98 });
    expect(order.items).toEqual([
      { productId: 'seed_prod1', originalPrice: 999.99, discountAmount: 100, priceAtOrder: 899.99, quantity: 2 },
    ]);
    expect(order.totalAmount).toBe(cart.finalTotal);

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
        price: 200,
        quantity: 10,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: 'pricing_cat',
      },
    });
    await prisma.discount.create({
      data: {
        id: 'pricing_flat30',
        name: 'Kettle GHS 30 off',
        type: 'FLAT',
        value: 30,
        ...activeWindow(),
        products: { connect: { id: 'pricing_kettle' } },
      },
    });
    await prisma.discount.create({
      data: {
        id: 'pricing_cat25',
        name: 'Kitchen 25% off',
        type: 'PERCENTAGE',
        value: 25,
        ...activeWindow(),
        categories: { connect: { id: 'pricing_cat' } },
      },
    });
    await addToCart('pricing_kettle', 1);

    const cart = await cartWithDiscount();
    expect(cart).toMatchObject({ total: 200, discountTotal: 50, finalTotal: 150 });

    const orderRes = await createPickupOrder();
    expect(orderRes.body.errors).toBeUndefined();
    expect(orderRes.body.data.createOrder).toMatchObject({ discountTotal: 50, totalAmount: 150 });
    const [item] = await prisma.orderItem.findMany({ where: { orderId: orderRes.body.data.createOrder.id } });
    expect(item.discountId).toBe('pricing_cat25');
  });

  it('no longer offers finalizeOrder', async () => {
    const res = await gqlRequest(app, `mutation { finalizeOrder(id: "any") { id } }`, undefined, userToken).expect(400);

    expect(res.body.errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
