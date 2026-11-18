import { BadGatewayException, INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import { OrderStatus, PaymentStatus } from '../../src/generated/prisma/client';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { createTestApp } from '../helpers/app.helper';
import { resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';

describe('Paystack webhook (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orderCount = 0;

  const paystack = {
    verifyTransaction: jest.fn(async (reference: string) => ({
      reference,
      status: 'success',
      amount: 10000,
      currency: 'GHS',
    })),
  };

  const sign = (raw: string) => createHmac('sha512', process.env.PAYSTACK_SECRET_KEY!).update(raw).digest('hex');

  const deliver = (raw: string, signature = sign(raw)) =>
    request(app.getHttpServer())
      .post('/payment/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(raw);

  /** A body formatted the way Paystack may send it: spaced, and with an escaped slash JSON.stringify would drop. */
  const chargeSuccess = (id: number, reference: string) =>
    `{"event": "charge.success", "data": {"id": ${id}, "reference": "${reference}", "status": "success", ` +
    `"amount": 10000, "currency": "GHS", "gateway_response": "Approved \\/ Successful", ` +
    `"customer": {"email": "buyer@example.com"}}}`;

  const pendingPayment = async () => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        userId: 'seed_user',
        totalAmount: 100,
        contactEmail: 'user@example.com',
        contactPhone: `+23324430${String(orderCount).padStart(4, '0')}`,
      },
    });
    const { reference } = await seedPaymentAttempt(prisma, { orderId: order.id, status: PaymentStatus.PENDING });
    return { orderId: order.id, reference };
  };

  const orderStatus = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    jest.spyOn(app.get(NotificationsService), 'sendPaymentConfirmation').mockReturnValue();
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await prisma.$executeRawUnsafe('TRUNCATE "WebhookEvent"');
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('accepts a body signed over its raw bytes, stores the event without PII and settles the payment', async () => {
    const { orderId, reference } = await pendingPayment();

    await deliver(chargeSuccess(1001, reference)).expect(200);

    const events = await prisma.webhookEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'PAYSTACK',
      event: 'charge.success',
      eventKey: 'charge.success:id:1001',
      reference,
      attempts: 1,
      lastError: null,
    });
    expect(events[0].processedAt).not.toBeNull();
    expect(JSON.stringify(events[0].payload)).not.toContain('buyer@example.com');
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(reference);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PROCESSING);
  });

  it('rejects the same event re-serialised differently under the original signature, storing nothing', async () => {
    const { orderId, reference } = await pendingPayment();
    const original = chargeSuccess(1002, reference);

    await deliver(JSON.stringify(JSON.parse(original)), sign(original)).expect(401);

    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    expect(await orderStatus(orderId)).toBe(OrderStatus.PENDING);
  });

  it.each([
    ['a wrong signature', 'not-a-valid-signature'],
    ['a signature from another secret', createHmac('sha512', 'sk_test_attacker').update('x').digest('hex')],
  ])('rejects %s with 401 and stores nothing', async (_label, signature) => {
    const { orderId, reference } = await pendingPayment();

    await deliver(chargeSuccess(1003, reference), signature).expect(401);

    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PENDING);
  });

  it('treats a second delivery of the same event as a no-op', async () => {
    const { orderId, reference } = await pendingPayment();
    const raw = chargeSuccess(1004, reference);

    await deliver(raw).expect(200);
    await deliver(raw).expect(200);

    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
    const attempts = await prisma.paymentAttempt.findMany({ where: { reference } });
    expect(attempts).toEqual([expect.objectContaining({ status: PaymentStatus.COMPLETED })]);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PROCESSING);
  });

  it('settles once when two deliveries of the same event race', async () => {
    const { orderId, reference } = await pendingPayment();
    const raw = chargeSuccess(1005, reference);

    const [first, second] = await Promise.all([deliver(raw), deliver(raw)]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.refund.count({ where: { attempt: { reference } } })).toBe(0);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PROCESSING);
  });

  it('keeps a failed event stored and retryable, answers 503, and processes it when Paystack redelivers', async () => {
    const { orderId, reference } = await pendingPayment();
    const raw = chargeSuccess(1006, reference);
    paystack.verifyTransaction.mockRejectedValue(new BadGatewayException('Paystack verify failed with HTTP 503'));

    await deliver(raw).expect(503);

    const failed = await prisma.webhookEvent.findFirstOrThrow();
    expect(failed).toMatchObject({ processedAt: null, attempts: 3, lastError: 'Paystack verify failed with HTTP 503' });
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(3);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PENDING);

    paystack.verifyTransaction.mockImplementation(async (ref: string) => ({
      reference: ref,
      status: 'success',
      amount: 10000,
      currency: 'GHS',
    }));
    await deliver(raw).expect(200);

    const processed = await prisma.webhookEvent.findFirstOrThrow();
    expect(processed.id).toBe(failed.id);
    expect(processed.processedAt).not.toBeNull();
    expect(processed).toMatchObject({ attempts: 4, lastError: null });
    expect(await orderStatus(orderId)).toBe(OrderStatus.PROCESSING);
  });

  it('stores and acknowledges an event type it does not handle, without contacting Paystack', async () => {
    const raw = '{"event":"refund.processed","data":{"id":77,"transaction_reference":"ref-x","amount":10000}}';

    await deliver(raw).expect(200);
    await deliver(raw).expect(200);

    const events = await prisma.webhookEvent.findMany();
    expect(events).toEqual([
      expect.objectContaining({ event: 'refund.processed', eventKey: 'refund.processed:id:77', reference: null }),
    ]);
    expect(events[0].processedAt).not.toBeNull();
    expect(paystack.verifyTransaction).not.toHaveBeenCalled();
  });
});
