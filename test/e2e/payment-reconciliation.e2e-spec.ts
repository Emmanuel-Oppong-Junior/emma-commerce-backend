import { INestApplication } from '@nestjs/common';
import { OrderStatus, PaymentStatus } from '../../src/generated/prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ListedTransaction, PaystackClient } from '../../src/payment/paystack.client';
import { PaymentReconciliationService } from '../../src/payment/payment-reconciliation.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { LoggerService } from '../../src/commons/logger.service';
import { createTestApp } from '../helpers/app.helper';
import { clearPaymentLedger, resetDb, seedMinimal, seedPaymentAttempt } from '../helpers/db.helper';

const MINUTE_MS = 60 * 1000;

describe('Payment reconciliation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let reconciliation: PaymentReconciliationService;
  let loggedErrors: jest.SpyInstance;
  let orderCount = 0;

  const paid = async (reference: string) => ({ reference, status: 'success', amount: 10000, currency: 'GHS' });
  const noTransactions = async (): Promise<{ transactions: ListedTransaction[]; pageCount: number }> => ({
    transactions: [],
    pageCount: 0,
  });
  const paystack = { verifyTransaction: jest.fn(paid), listTransactions: jest.fn(noTransactions) };

  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * MINUTE_MS);

  const createOrder = async (): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        userId: 'seed_user',
        totalAmount: 100,
        contactEmail: 'user@example.com',
        contactPhone: `+23324430${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };

  const openAttempt = async (createdAt: Date, status: PaymentStatus = PaymentStatus.PENDING) => {
    const orderId = await createOrder();
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId, status });
    await prisma.paymentAttempt.update({ where: { id: paymentId }, data: { createdAt } });
    return { orderId, paymentId, reference };
  };

  const orderStatus = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } })).status;
  const attemptStatus = async (paymentId: string) =>
    (await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: paymentId }, select: { status: true } })).status;
  const verifiedReferences = () => paystack.verifyTransaction.mock.calls.map(([reference]) => reference);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    reconciliation = app.get(PaymentReconciliationService);
    jest.spyOn(app.get(NotificationsService), 'sendPaymentConfirmation').mockReturnValue();
    loggedErrors = jest.spyOn(app.get(LoggerService), 'error');
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    paystack.verifyTransaction.mockImplementation(paid);
    paystack.listTransactions.mockImplementation(noTransactions);
    await clearPaymentLedger(prisma);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('settles a 20-minute-old attempt Paystack reports paid and leaves fresh and day-old attempts alone', async () => {
    const stale = await openAttempt(minutesAgo(20));
    const superseded = await openAttempt(minutesAgo(60), PaymentStatus.ABANDONED);
    const fresh = await openAttempt(minutesAgo(5));
    const dayOld = await openAttempt(minutesAgo(25 * 60));

    const summary = await reconciliation.sweep(new Date());

    expect(summary?.attempts).toEqual({ checked: 2, settled: 2, stillOpen: 0, failed: 0 });
    expect(verifiedReferences().sort()).toEqual([stale.reference, superseded.reference].sort());
    expect(await orderStatus(stale.orderId)).toBe(OrderStatus.PROCESSING);
    expect(await attemptStatus(stale.paymentId)).toBe(PaymentStatus.COMPLETED);
    expect(await orderStatus(superseded.orderId)).toBe(OrderStatus.PROCESSING);
    expect(await attemptStatus(fresh.paymentId)).toBe(PaymentStatus.PENDING);
    expect(await attemptStatus(dayOld.paymentId)).toBe(PaymentStatus.PENDING);
  });

  it('keeps an attempt Paystack has not decided open without touching it on later sweeps', async () => {
    paystack.verifyTransaction.mockImplementation(async (reference: string) => ({
      reference,
      status: 'abandoned',
      amount: 10000,
      currency: 'GHS',
    }));
    const stale = await openAttempt(minutesAgo(20));

    await reconciliation.sweep(new Date());
    const afterFirst = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: stale.paymentId } });
    const second = await reconciliation.sweep(new Date());
    const afterSecond = await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: stale.paymentId } });

    expect(second?.attempts).toEqual({ checked: 1, settled: 0, stillOpen: 1, failed: 0 });
    expect(afterFirst).toMatchObject({ status: PaymentStatus.PENDING, rawStatus: 'abandoned' });
    expect(afterSecond.updatedAt).toEqual(afterFirst.updatedAt);
    expect(await orderStatus(stale.orderId)).toBe(OrderStatus.PENDING);
  });

  it('reprocesses a stored, unprocessed webhook event once', async () => {
    const fresh = await openAttempt(new Date());
    const event = await prisma.webhookEvent.create({
      data: {
        provider: 'PAYSTACK',
        eventKey: `charge.success:reference:${fresh.reference}`,
        event: 'charge.success',
        reference: fresh.reference,
        payload: { event: 'charge.success', data: { reference: fresh.reference } },
        receivedAt: minutesAgo(10),
        attempts: 3,
        lastError: 'Paystack verify did not answer within 8000 ms',
      },
    });

    const first = await reconciliation.sweep(new Date());
    const second = await reconciliation.sweep(new Date());

    expect(first?.webhooks).toEqual({ processed: 1, skipped: 0, failed: 0 });
    expect(second?.webhooks).toEqual({ processed: 0, skipped: 0, failed: 0 });
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toMatchObject({
      processedAt: expect.any(Date),
      attempts: 4,
      lastError: null,
    });
    expect(await orderStatus(fresh.orderId)).toBe(OrderStatus.PROCESSING);
  });

  it('nightly diff logs a Paystack-only success and settles a success whose webhook was missed', async () => {
    const missed = await openAttempt(minutesAgo(26 * 60));
    paystack.listTransactions.mockResolvedValue({
      transactions: [
        { reference: 'paystack-only-ref', status: 'success', amount: 5000, currency: 'GHS' },
        { reference: missed.reference, status: 'success', amount: 10000, currency: 'GHS' },
      ],
      pageCount: 1,
    });

    const summary = await reconciliation.diffPreviousDay(new Date());

    expect(summary).toMatchObject({
      paystackSuccesses: 2,
      complete: true,
      mismatches: { PAYSTACK_ONLY: 1, UNSETTLED: 1, STATUS_MISMATCH: 0, AMOUNT_MISMATCH: 0 },
      recovered: 1,
    });
    expect(await orderStatus(missed.orderId)).toBe(OrderStatus.PROCESSING);
    expect(await attemptStatus(missed.paymentId)).toBe(PaymentStatus.COMPLETED);
    const messages = loggedErrors.mock.calls.map(([message]) => message as string);
    expect(messages).toContain(
      'Payment reconciliation mismatch | kind: PAYSTACK_ONLY | reference: paystack-only-ref | paystack: 5000 GHS | ledger: none',
    );
    expect(messages).toContainEqual(expect.stringContaining(`kind: UNSETTLED | reference: ${missed.reference}`));
  });

  it('two sweeps at once: one does the work, the other skips', async () => {
    const stale = await openAttempt(minutesAgo(20));
    paystack.verifyTransaction.mockImplementation(async (reference: string) => {
      await sleep(500);
      return paid(reference);
    });

    const runs = await Promise.all([reconciliation.sweep(new Date()), reconciliation.sweep(new Date())]);

    expect(runs.filter((run) => run === null)).toHaveLength(1);
    expect(paystack.verifyTransaction).toHaveBeenCalledTimes(1);
    expect(await orderStatus(stale.orderId)).toBe(OrderStatus.PROCESSING);
  });
});
