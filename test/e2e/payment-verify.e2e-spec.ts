import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { OrderStatus, PaymentIntentStatus, PaymentStatus, Prisma } from '@prisma/client';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';

interface VerifyResult {
  reference: string;
  status: string;
  amount?: number;
  currency?: string;
}

describe('Payment verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let sendPaymentConfirmation: jest.SpyInstance;
  let orderCount = 0;

  const charged: Partial<VerifyResult> = { status: 'success', amount: 10000, currency: 'GHS' };
  const paystack = {
    verifyTransaction: jest.fn(
      async (reference: string): Promise<VerifyResult> => ({
        reference,
        status: 'success',
        amount: 10000,
        currency: 'GHS',
      }),
    ),
  };
  const paystackAnswers = (data: Partial<VerifyResult>) =>
    paystack.verifyTransaction.mockImplementation(async (reference) => ({ reference, status: 'success', ...data }));

  const createOrder = async (data: Partial<Prisma.OrderUncheckedCreateInput> = {}): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        userId: 'seed_user',
        totalAmount: 100,
        contactEmail: 'user@example.com',
        contactPhone: `+23324420${String(orderCount).padStart(4, '0')}`,
        ...data,
      },
    });
    return order.id;
  };

  const verify = (reference: string) =>
    gqlRequest(
      app,
      `mutation { verifyPayment(verifyPaymentInput: { reference: "${reference}" }) { id status } }`,
      undefined,
      userToken,
    );

  const webhook = (reference: string) => {
    const body = { event: 'charge.success', data: { reference, amount: 10000, currency: 'GHS' } };
    const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(JSON.stringify(body)).digest('hex');
    return request(app.getHttpServer()).post('/payment/webhook').set('x-paystack-signature', signature).send(body);
  };

  const ledgerOf = async (orderId: string) => {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: {
        paymentIntent: { include: { attempts: { include: { refunds: true }, orderBy: { createdAt: 'asc' } } } },
      },
    });
    const attempts = order.paymentIntent?.attempts ?? [];
    return {
      orderStatus: order.status,
      intentStatus: order.paymentIntent?.status,
      attempts,
      refunds: attempts.flatMap((attempt) => attempt.refunds),
    };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    sendPaymentConfirmation = jest.spyOn(app.get(NotificationsService), 'sendPaymentConfirmation').mockReturnValue();
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    paystackAnswers(charged);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('pays a PENDING order once and ignores a replayed verify on the PROCESSING order', async () => {
    const orderId = await createOrder();
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });

    const first = await verify(reference).expect(200);
    const second = await verify(reference).expect(200);

    expect(first.body.data.verifyPayment.status).toBe(PaymentStatus.COMPLETED);
    expect(second.body.data.verifyPayment.status).toBe(PaymentStatus.COMPLETED);
    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.PROCESSING);
    expect(ledger.intentStatus).toBe(PaymentIntentStatus.PAID);
    expect(ledger.attempts[0]).toMatchObject({
      status: PaymentStatus.COMPLETED,
      rawStatus: 'success',
      reviewReason: null,
    });
    expect(ledger.refunds).toHaveLength(0);
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(sendPaymentConfirmation).toHaveBeenCalledTimes(1);
  });

  it('changes nothing when a paid reference is verified again after the order was DELIVERED', async () => {
    const orderId = await createOrder({ status: OrderStatus.DELIVERED });
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.COMPLETED });

    await verify(reference).expect(200);
    await webhook(reference).expect(200);

    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.DELIVERED);
    expect(ledger.refunds).toHaveLength(0);
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
  });

  it('keeps a cancelled order CANCELLED, flags the late payment and queues exactly one refund across replays', async () => {
    const orderId = await createOrder();
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });
    await gqlRequest(app, `mutation { cancelOrder(orderId: "${orderId}") { id status } }`, undefined, userToken).expect(
      200,
    );

    await verify(reference).expect(200);
    await webhook(reference).expect(200);
    await verify(reference).expect(200);

    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.CANCELLED);
    expect(ledger.intentStatus).toBe(PaymentIntentStatus.PENDING);
    expect(ledger.attempts[0]).toMatchObject({ status: PaymentStatus.COMPLETED, reviewReason: 'ORDER_NOT_PAYABLE' });
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0]).toMatchObject({
      status: 'PENDING',
      currency: 'GHS',
      idempotencyKey: `auto-refund:${ledger.attempts[0].id}`,
    });
    expect(ledger.refunds[0].amount.toString()).toBe('100');
    expect(sendPaymentConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    ['a smaller amount', { amount: 9999 }, 'AMOUNT_MISMATCH', '99.99', 'GHS'],
    ['another currency', { currency: 'USD' }, 'CURRENCY_MISMATCH', '100', 'USD'],
  ])('does not pay the order for a success in %s', async (_label, answer, reason, refundAmount, refundCurrency) => {
    const orderId = await createOrder();
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });
    paystackAnswers({ ...charged, ...answer });

    const res = await verify(reference).expect(200);
    await verify(reference).expect(200);

    expect(res.body.data.verifyPayment.status).toBe(PaymentStatus.FAILED);
    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.PENDING);
    expect(ledger.intentStatus).toBe(PaymentIntentStatus.PENDING);
    expect(ledger.attempts[0]).toMatchObject({
      status: PaymentStatus.FAILED,
      rawStatus: 'success',
      reviewReason: reason,
    });
    expect(ledger.refunds).toHaveLength(1);
    expect(ledger.refunds[0].amount.toString()).toBe(refundAmount);
    expect(ledger.refunds[0].currency).toBe(refundCurrency);
    expect(sendPaymentConfirmation).not.toHaveBeenCalled();
  });

  it('flags a second successful attempt for an order already paid and queues its refund', async () => {
    const orderId = await createOrder();
    const first = await seedPaymentAttempt(prisma, {
      orderId,
      status: PaymentStatus.ABANDONED,
      reference: `${orderId}-a`,
    });
    const second = await seedPaymentAttempt(prisma, {
      orderId,
      status: PaymentStatus.PENDING,
      reference: `${orderId}-b`,
    });

    await verify(second.reference).expect(200);
    await verify(first.reference).expect(200);

    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.PROCESSING);
    const late = ledger.attempts.find((attempt) => attempt.id === first.paymentId)!;
    expect(late).toMatchObject({ status: PaymentStatus.COMPLETED, reviewReason: 'ALREADY_PAID' });
    expect(ledger.refunds).toEqual([expect.objectContaining({ attemptId: first.paymentId, status: 'PENDING' })]);
    expect(sendPaymentConfirmation).toHaveBeenCalledTimes(1);
  });

  it('moves the order once when the customer verify and the webhook race', async () => {
    const orderId = await createOrder();
    const { reference } = await seedPaymentAttempt(prisma, { orderId, status: PaymentStatus.PENDING });

    const [verified, hooked] = await Promise.all([verify(reference), webhook(reference)]);

    expect(verified.status).toBe(200);
    expect(hooked.status).toBe(200);
    const ledger = await ledgerOf(orderId);
    expect(ledger.orderStatus).toBe(OrderStatus.PROCESSING);
    expect(ledger.attempts[0]).toMatchObject({ status: PaymentStatus.COMPLETED, reviewReason: null });
    expect(ledger.refunds).toHaveLength(0);
    expect(sendPaymentConfirmation).toHaveBeenCalledTimes(1);
  });
});
