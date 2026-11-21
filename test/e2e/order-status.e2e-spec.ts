import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, stockOf as ledgerStockOf } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { quoteHashFor } from '../helpers/checkout.helper';

describe('Order status rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let addressId: string;

  const stockOf = async () => (await ledgerStockOf(prisma, 'seed_var1')).available;

  const placeOrder = async (): Promise<string> => {
    await gqlRequest(
      app,
      'mutation { addToCart(input: { variantId: "seed_var1", quantity: 2 }) { id } }',
      undefined,
      userToken,
    ).expect(200);
    const res = await gqlRequest(
      app,
      `mutation { createOrder(input: { quoteHash: "${await quoteHashFor(app, userToken, { fulfillmentType: 'DELIVERY', shippingAddressId: addressId })}", fulfillmentType: DELIVERY, shippingAddressId: "${addressId}",
        contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id status } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.createOrder.id;
  };

  const moveShipment = (orderId: string, status: string) =>
    gqlRequest(
      app,
      `mutation { updateShipmentStatus(input: { orderId: "${orderId}", status: ${status} }) { id status } }`,
      undefined,
      adminToken,
    ).expect(200);

  const codeOf = (res: { body: { errors?: { extensions?: { code?: string } }[] } }) =>
    res.body.errors?.[0]?.extensions?.code;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
    const addr = await gqlRequest(
      app,
      `mutation { createAddress(input: { street: "1 Order St", city: "Accra", recipientName: "Test Customer", phone: "0244000000", region: GREATER_ACCRA,
        zipCode: "00233", country: "GH" }) { id } }`,
      undefined,
      userToken,
    ).expect(200);
    addressId = addr.body.data.createAddress.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('cancels exactly once when the customer and an admin cancel at the same time', async () => {
    const before = await stockOf();
    const orderId = await placeOrder();
    expect(await stockOf()).toBe(before - 2);

    const [byCustomer, byAdmin] = await Promise.all([
      gqlRequest(app, `mutation { cancelOrder(orderId: "${orderId}") { id status } }`, undefined, userToken),
      gqlRequest(app, `mutation { adminCancelOrder(orderId: "${orderId}") { id status } }`, undefined, adminToken),
    ]);

    const outcomes = [byCustomer, byAdmin].map((res) => (res.body.errors ? codeOf(res) : 'OK')).sort();
    expect(outcomes).toEqual(['CONFLICT', 'OK']);
    expect(await stockOf()).toBe(before);
  });

  it('rejects dispatching a cancelled order', async () => {
    const orderId = await placeOrder();
    await gqlRequest(app, `mutation { cancelOrder(orderId: "${orderId}") { id } }`, undefined, userToken).expect(200);

    const res = await moveShipment(orderId, 'OUT_FOR_DELIVERY');

    expect(codeOf(res)).toBe('CONFLICT');
    expect(res.body.errors[0].message).toBe(
      `Order "${orderId}" is CANCELLED; only CONFIRMED or IN_FULFILMENT orders can be fulfilled`,
    );
  });

  it('does not let staff fulfil an unpaid online order', async () => {
    const orderId = await placeOrder();

    const res = await moveShipment(orderId, 'PICKING');

    expect(codeOf(res)).toBe('CONFLICT');
    expect(res.body.errors[0].message).toMatch(/is PLACED; only CONFIRMED or IN_FULFILMENT/);
  });

  it('no longer offers updateOrderStatus: order status follows payment, cancellation and the shipment', async () => {
    const res = await gqlRequest(
      app,
      `mutation { updateOrderStatus(input: { orderId: "any", status: CANCELLED }) { id } }`,
      undefined,
      adminToken,
    ).expect(400);

    expect(codeOf(res)).toBe('GRAPHQL_VALIDATION_FAILED');
  });

  it('returns stock when an admin cancels with a reason, recorded in the timeline', async () => {
    const before = await stockOf();
    const orderId = await placeOrder();

    const res = await gqlRequest(
      app,
      `mutation { adminCancelOrder(orderId: "${orderId}", reason: "Customer called") {
        status timeline { from to reason actorId } } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.adminCancelOrder.status).toBe('CANCELLED');
    expect(res.body.data.adminCancelOrder.timeline).toEqual([
      { from: null, to: 'PLACED', reason: null, actorId: 'seed_user' },
      { from: 'PLACED', to: 'CANCELLED', reason: 'Customer called', actorId: 'seed_admin' },
    ]);
    expect(await stockOf()).toBe(before);
  });
});
