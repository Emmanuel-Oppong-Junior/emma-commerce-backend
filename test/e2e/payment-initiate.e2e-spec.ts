import { INestApplication } from '@nestjs/common';
import { OrderStatus, PaymentMethod, PaymentStatus, Prisma } from '../../src/generated/prisma/client';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

interface InitializeParams {
  reference: string;
  amount: number;
  currency: string;
}

describe('Payment initiation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let orderCount = 0;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: InitializeParams) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(async (reference: string) => ({
      reference,
      status: 'success',
      amount: 10000,
      currency: 'GHS',
    })),
  };

  const createOrder = async (data: Partial<Prisma.OrderUncheckedCreateInput> = {}): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324410${String(orderCount).padStart(4, '0')}`,
        ...data,
      },
    });
    return order.id;
  };

  const initiate = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ paymentMethod: 'CARD', ...body });

  const attemptsOf = (orderId: string) =>
    prisma.paymentAttempt.findMany({ where: { intent: { orderId } }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('opens a checkout charged at the order total in GHS', async () => {
    const orderId = await createOrder();

    const res = await initiate({ orderId }).expect(201);

    const [attempt] = await attemptsOf(orderId);
    expect(res.body.authorizationUrl).toBe(`https://checkout.test/${attempt.reference}`);
    expect(paystack.initializeTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000, currency: 'GHS', reference: attempt.reference }),
    );
    expect(attempt).toMatchObject({ status: PaymentStatus.PENDING, currency: 'GHS' });
    expect(attempt.amount.toString()).toBe('100');
  });

  it('rejects a client-supplied amount', async () => {
    const orderId = await createOrder();

    await initiate({ orderId, amount: 1 }).expect(400);

    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['a cancelled order', { status: OrderStatus.CANCELLED }, 400],
    ['a processing order', { status: OrderStatus.CONFIRMED }, 400],
    ['a cash-on-delivery order', { paymentMethod: PaymentMethod.CASH_ON_DELIVERY }, 400],
    ['a soft-deleted order', { deleted: true, deletedAt: new Date() }, 404],
  ])('refuses to open a checkout for %s', async (_label, data, statusCode) => {
    const orderId = await createOrder(data);

    await initiate({ orderId }).expect(statusCode);

    expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    expect(await attemptsOf(orderId)).toHaveLength(0);
  });

  it('keeps the earlier attempt on retry, abandoned but still verifiable, and then refuses a third checkout', async () => {
    const orderId = await createOrder();
    await initiate({ orderId, idempotencyKey: 'first' }).expect(201);
    await initiate({ orderId, idempotencyKey: 'second' }).expect(201);

    const [first, second] = await attemptsOf(orderId);
    expect(first.status).toBe(PaymentStatus.CANCELLED);
    expect(second.status).toBe(PaymentStatus.PENDING);

    const verified = await gqlRequest(
      app,
      `mutation { verifyPayment(verifyPaymentInput: { reference: "${first.reference}" }) { id status } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(verified.body.data.verifyPayment).toEqual({ id: first.id, status: PaymentStatus.CAPTURED });

    await initiate({ orderId, idempotencyKey: 'third' }).expect(400);
    expect(await attemptsOf(orderId)).toHaveLength(2);
  });

  it('returns the same attempt and checkout for a repeated idempotency key', async () => {
    const orderId = await createOrder();

    const first = await initiate({ orderId, idempotencyKey: 'same-key' }).expect(201);
    const second = await initiate({ orderId, idempotencyKey: 'same-key' }).expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect(second.body.authorizationUrl).toBe(first.body.authorizationUrl);
    expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
    expect(await attemptsOf(orderId)).toHaveLength(1);
  });

  it('leaves exactly one live attempt when initiations race', async () => {
    const orderId = await createOrder();

    const responses = await Promise.all(Array.from({ length: 5 }, () => initiate({ orderId })));

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    const attempts = await attemptsOf(orderId);
    expect(attempts).toHaveLength(5);
    expect(attempts.filter((a) => a.status === PaymentStatus.PENDING)).toHaveLength(1);
  });

  it('opens one attempt when the same idempotency key races', async () => {
    const orderId = await createOrder();

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => initiate({ orderId, idempotencyKey: 'racing-key' })),
    );

    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    const [attempt, ...others] = await attemptsOf(orderId);
    expect(others).toHaveLength(0);
    for (const res of responses.filter((r) => r.status === 201)) {
      expect(res.body.id).toBe(attempt.id);
    }
    expect(paystack.initializeTransaction).toHaveBeenCalledTimes(1);
  });

  it('lets the same key be retried after Paystack failed to open the checkout', async () => {
    const orderId = await createOrder();
    paystack.initializeTransaction.mockRejectedValueOnce(new Error('Paystack unavailable'));

    await initiate({ orderId, idempotencyKey: 'retry-key' }).expect(500);
    await initiate({ orderId, idempotencyKey: 'retry-key' }).expect(201);

    const [failed, retried] = await attemptsOf(orderId);
    expect(failed).toMatchObject({ status: PaymentStatus.FAILED, idempotencyKey: null });
    expect(retried).toMatchObject({ status: PaymentStatus.PENDING, idempotencyKey: 'retry-key' });
  });
});
