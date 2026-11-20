import { BadGatewayException, INestApplication, INestApplicationContext } from '@nestjs/common';
import { createHmac } from 'crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderStatus, PaymentStatus } from '../../src/generated/prisma/client';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { JobQueue } from '../../src/jobs/job-queues';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, takeOrderNumber } from '../helpers/db.helper';

// The API stores a verified delivery and answers 200; the worker's webhooks queue processes it with retries.
describe('Paystack webhook (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let orderCount = 0;

  const paystackSuccess = async (reference: string) => ({
    reference,
    status: 'success',
    amount: 10000,
    currency: 'GHS',
  });
  const paystack = { verifyTransaction: jest.fn(paystackSuccess) };

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
        orderNumber: await takeOrderNumber(prisma),
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

  async function eventuallyStored(predicate: (event: { processedAt: Date | null; attempts: number }) => boolean) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      const event = await prisma.webhookEvent.findFirst();
      if (event && predicate(event)) return event;
      if (Date.now() > deadline) throw new Error(`Webhook event never reached the state: ${JSON.stringify(event)}`);
      await sleep(100);
    }
  }

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await clearQueues(app);
    worker = await createTestWorker((builder) => builder.overrideProvider(PaystackClient).useValue(paystack));
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    paystack.verifyTransaction.mockImplementation(paystackSuccess);
    await prisma.$executeRawUnsafe('TRUNCATE "WebhookEvent"');
  });

  afterAll(async () => {
    await clearQueues(app);
    await worker.close();
    await resetDb(prisma);
    await app.close();
  });

  it('stores the event without PII before answering, then the worker settles the payment once', async () => {
    const { orderId, reference } = await pendingPayment();

    await deliver(chargeSuccess(1001, reference)).expect(200);

    const events = await prisma.webhookEvent.findMany();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'PAYSTACK',
      event: 'charge.success',
      eventKey: 'charge.success:id:1001',
      reference,
    });
    expect(JSON.stringify(events[0].payload)).not.toContain('buyer@example.com');
    // meta carries the delivery's request id so the worker's logs for this job correlate with it (P1-L.1).
    expect((await getQueue(app, JobQueue.WEBHOOKS).getJob(events[0].id))?.data).toEqual({
      webhookEventId: events[0].id,
      meta: { requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    });

    const processed = await eventuallyStored((event) => event.processedAt !== null);
    expect(processed).toMatchObject({ attempts: 1, lastError: null });
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
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

  it('treats a second delivery of a processed event as a no-op', async () => {
    const { orderId, reference } = await pendingPayment();
    const raw = chargeSuccess(1004, reference);

    await deliver(raw).expect(200);
    await eventuallyStored((event) => event.processedAt !== null);
    await deliver(raw).expect(200);
    await sleep(300);

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
    await eventuallyStored((event) => event.processedAt !== null);
    expect(await prisma.refund.count({ where: { attempt: { reference } } })).toBe(0);
    expect(await orderStatus(orderId)).toBe(OrderStatus.PROCESSING);
  });

  // Contract change (P1-J.4): a processing failure no longer answers 503. The event is stored, Paystack gets 200,
  // and the queue retries the stored event with backoff until it succeeds.
  it('answers 200 even when processing fails, and the queue retries the stored event until it succeeds', async () => {
    const { orderId, reference } = await pendingPayment();
    paystack.verifyTransaction.mockRejectedValue(new BadGatewayException('Paystack verify failed with HTTP 503'));

    await deliver(chargeSuccess(1006, reference)).expect(200);

    const failed = await eventuallyStored((event) => event.attempts >= 1);
    expect(failed).toMatchObject({ processedAt: null, lastError: 'Paystack verify failed with HTTP 503' });
    expect(await orderStatus(orderId)).toBe(OrderStatus.PENDING);
    const job = await getQueue(app, JobQueue.WEBHOOKS).getJob(failed.id);
    expect(await job?.getState()).toBe('delayed');

    paystack.verifyTransaction.mockImplementation(paystackSuccess);

    const processed = await eventuallyStored((event) => event.processedAt !== null);
    expect(processed.id).toBe(failed.id);
    expect(processed).toMatchObject({ attempts: 2, lastError: null });
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
    await expect(getQueue(app, JobQueue.WEBHOOKS).getJob(events[0].id)).resolves.toBeUndefined();
  });
});
