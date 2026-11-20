import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

describe('Order status rules (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let addressId: string;

  const stockOf = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' }, select: { quantity: true } })).quantity;

  const placeOrder = async (): Promise<string> => {
    await gqlRequest(
      app,
      'mutation { addToCart(input: { productId: "seed_prod1", quantity: 2 }) { id } }',
      undefined,
      userToken,
    ).expect(200);
    const res = await gqlRequest(
      app,
      `mutation { createOrder(input: { fulfillmentType: DELIVERY, shippingAddressId: "${addressId}",
        contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id status } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.createOrder.id;
  };

  const setStatus = (orderId: string, status: string) =>
    gqlRequest(
      app,
      `mutation { updateOrderStatus(input: { orderId: "${orderId}", status: ${status} }) { id status } }`,
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

  it('rejects moving a cancelled order to SHIPPED', async () => {
    const orderId = await placeOrder();
    await gqlRequest(app, `mutation { cancelOrder(orderId: "${orderId}") { id } }`, undefined, userToken).expect(200);

    const res = await setStatus(orderId, 'SHIPPED');

    expect(codeOf(res)).toBe('CONFLICT');
    expect(res.body.errors[0].message).toBe(`Order "${orderId}" cannot move from CANCELLED to SHIPPED`);
  });

  it('does not let an admin mark an unpaid online order as PROCESSING', async () => {
    const orderId = await placeOrder();

    const res = await setStatus(orderId, 'PROCESSING');

    expect(codeOf(res)).toBe('CONFLICT');
    expect(res.body.errors[0].message).toMatch(/awaiting online payment/);
  });

  it('returns stock when an admin cancels through updateOrderStatus', async () => {
    const before = await stockOf();
    const orderId = await placeOrder();

    const res = await setStatus(orderId, 'CANCELLED');

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.updateOrderStatus.status).toBe('CANCELLED');
    expect(await stockOf()).toBe(before);
  });
});
