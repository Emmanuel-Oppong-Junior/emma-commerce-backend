import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';

describe('Stock is restored exactly once (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let addressId: string;
  const paystack = { createRefund: jest.fn(async () => ({ id: 'rf_stock', status: 'pending' })) };

  const stockOf = async () =>
    (await prisma.product.findUniqueOrThrow({ where: { id: 'seed_prod1' }, select: { quantity: true } })).quantity;
  const restoreLogsFor = (orderId: string) =>
    prisma.inventoryLog.count({ where: { action: 'RETURN_RESTORE', reason: { contains: orderId } } });

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
        contactEmail: "user@example.com", contactPhone: "+233244000000" }) { id } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(res.body.errors).toBeUndefined();
    return res.body.data.createOrder.id;
  };

  const admin = (query: string) => gqlRequest(app, query, undefined, adminToken).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
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
    jest.restoreAllMocks();
    await app.close();
  });

  it('cancelling a paid online order and refunding it returns stock once, with one log per item', async () => {
    const before = await stockOf();
    const orderId = await placeOrder();
    await seedPaymentAttempt(prisma, { orderId, status: 'COMPLETED', reference: `ref-${orderId}` });
    await prisma.order.update({ where: { id: orderId }, data: { status: 'PROCESSING' } });

    const cancel = await gqlRequest(
      app,
      `mutation { cancelOrder(orderId: "${orderId}") { status } }`,
      undefined,
      userToken,
    );
    expect(cancel.body.errors).toBeUndefined();
    expect(await stockOf()).toBe(before);

    const returnRequest = await prisma.returnRequest.findFirstOrThrow({ where: { orderId } });
    const approve = await admin(
      `mutation { approveReturn(input: { returnRequestId: "${returnRequest.id}", refundAmount: "100.00" }) { status } }`,
    );
    expect(approve.body.errors).toBeUndefined();
    const refund = await admin(`mutation { processRefund(returnRequestId: "${returnRequest.id}") { status } }`);

    expect(refund.body.errors).toBeUndefined();
    expect(refund.body.data.processRefund.status).toBe('REFUNDED');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(await stockOf()).toBe(before);
    expect(await restoreLogsFor(orderId)).toBe(1);
  });

  it('deleting a delivered order leaves stock unchanged', async () => {
    const orderId = await placeOrder();
    await prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED' } });
    const afterSale = await stockOf();

    const res = await admin(`mutation { deleteOrder(orderId: "${orderId}") { id } }`);

    expect(res.body.errors).toBeUndefined();
    expect(await stockOf()).toBe(afterSale);
  });

  it('refuses to delete an open order, so its reserved stock is not lost', async () => {
    const orderId = await placeOrder();

    const res = await admin(`mutation { deleteOrder(orderId: "${orderId}") { id } }`);

    expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    expect(res.body.errors[0].message).toMatch(/cancel it first/);
  });
});
