import { BadGatewayException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import {
  DIFF_MAX_PAGES,
  PAYMENT_DIFF_LOCK_KEY,
  PAYMENT_SWEEP_LOCK_KEY,
  PaymentReconciliationService,
  STALE_ATTEMPT_BATCH,
  WEBHOOK_SWEEP_BATCH,
  WEBHOOK_SWEEP_MAX_ATTEMPTS,
} from './payment-reconciliation.service';
import { providerRegistryWith } from '../../test/helpers/payment-providers.helper';

const NOW = new Date('2026-11-18T01:30:00.000Z');
const DAY_START = new Date('2026-11-17T00:00:00.000Z');
const DAY_END = new Date('2026-11-18T00:00:00.000Z');

describe('PaymentReconciliationService', () => {
  const paymentRepository = { findOpenPaystackReferences: jest.fn(), findLedgerAttempts: jest.fn() };
  const webhookEvents = { findUnprocessed: jest.fn() };
  const paymentService = { verifyPayment: jest.fn() };
  const webhookService = { reprocessStoredEvent: jest.fn() };
  const paystack = { listTransactions: jest.fn() };
  const ordersRepository = { runWithAdvisoryLock: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new PaymentReconciliationService(
    paymentRepository as never,
    webhookEvents as never,
    paymentService as never,
    webhookService as never,
    providerRegistryWith(paystack),
    ordersRepository as never,
    logger as never,
  );

  const event = (id: string, attempts = 3) => ({ id, event: 'charge.success', reference: `ref-${id}`, attempts });
  const errorLines = () => logger.error.mock.calls.map(([message]) => message as string);

  beforeEach(() => {
    jest.clearAllMocks();
    ordersRepository.runWithAdvisoryLock.mockImplementation((_key, _ms, fn: () => Promise<unknown>) => fn());
    webhookEvents.findUnprocessed.mockResolvedValue([]);
    paymentRepository.findOpenPaystackReferences.mockResolvedValue([]);
    paymentRepository.findLedgerAttempts.mockResolvedValue([]);
    paystack.listTransactions.mockResolvedValue({ transactions: [], pageCount: 0 });
  });

  describe('sweep', () => {
    it('skips the run when another instance holds the sweep lock', async () => {
      ordersRepository.runWithAdvisoryLock.mockResolvedValue(null);

      await expect(service.sweep(NOW)).resolves.toBeNull();
      expect(ordersRepository.runWithAdvisoryLock).toHaveBeenCalledWith(
        PAYMENT_SWEEP_LOCK_KEY,
        expect.any(Number),
        expect.any(Function),
      );
      expect(paymentService.verifyPayment).not.toHaveBeenCalled();
    });

    it('selects events older than five minutes under the attempt cap, and attempts in the stale window', async () => {
      await service.sweep(NOW);

      expect(webhookEvents.findUnprocessed).toHaveBeenCalledWith(
        new Date('2026-11-18T01:25:00.000Z'),
        WEBHOOK_SWEEP_MAX_ATTEMPTS,
        WEBHOOK_SWEEP_BATCH,
      );
      expect(paymentRepository.findOpenPaystackReferences).toHaveBeenCalledWith(
        new Date('2026-11-17T01:30:00.000Z'),
        new Date('2026-11-18T01:15:00.000Z'),
        STALE_ATTEMPT_BATCH,
      );
    });

    it('reprocesses each stored event and keeps going after one fails or throws', async () => {
      webhookEvents.findUnprocessed.mockResolvedValue([event('e1'), event('e2'), event('e3'), event('e4')]);
      webhookService.reprocessStoredEvent
        .mockResolvedValueOnce('failed')
        .mockRejectedValueOnce(new Error('db down'))
        .mockResolvedValueOnce('skipped')
        .mockResolvedValueOnce('processed');

      const summary = await service.sweep(NOW);

      expect(webhookService.reprocessStoredEvent).toHaveBeenCalledTimes(4);
      expect(summary?.webhooks).toEqual({ processed: 1, skipped: 1, failed: 2 });
    });

    it('logs an error once an event reaches the attempt cap', async () => {
      webhookEvents.findUnprocessed.mockResolvedValue([event('e1', WEBHOOK_SWEEP_MAX_ATTEMPTS - 1)]);
      webhookService.reprocessStoredEvent.mockResolvedValue('failed');

      await service.sweep(NOW);

      expect(errorLines()).toEqual([expect.stringContaining('Webhook reprocessing given up | id: e1')]);
    });

    it('re-verifies each stale attempt, counting settled, still open and failed ones', async () => {
      paymentRepository.findOpenPaystackReferences.mockResolvedValue(['r1', 'r2', 'r3']);
      paymentService.verifyPayment
        .mockResolvedValueOnce({ status: 'CAPTURED' })
        .mockRejectedValueOnce(new BadGatewayException('Paystack verify failed with HTTP 503'))
        .mockResolvedValueOnce({ status: 'PENDING' });

      const summary = await service.sweep(NOW);

      expect(paymentService.verifyPayment.mock.calls).toEqual([['r1'], ['r2'], ['r3']]);
      expect(summary?.attempts).toEqual({ checked: 3, settled: 1, stillOpen: 1, failed: 1 });
    });
  });

  describe('diffPreviousDay', () => {
    const tx = (reference: string, amount = 10000) => ({ reference, status: 'success', amount, currency: 'GHS' });
    const ledger = (reference: string, status: string) => ({
      reference,
      status,
      amount: new Prisma.Decimal(100),
      currency: 'GHS',
      reviewReason: null,
    });

    it('skips the run when another instance holds the diff lock', async () => {
      ordersRepository.runWithAdvisoryLock.mockResolvedValue(null);

      await expect(service.diffPreviousDay(NOW)).resolves.toBeNull();
      expect(ordersRepository.runWithAdvisoryLock).toHaveBeenCalledWith(
        PAYMENT_DIFF_LOCK_KEY,
        expect.any(Number),
        expect.any(Function),
      );
      expect(paystack.listTransactions).not.toHaveBeenCalled();
    });

    it('pages through the successes of the previous day until the last page', async () => {
      paystack.listTransactions
        .mockResolvedValueOnce({ transactions: [tx('r1')], pageCount: 2 })
        .mockResolvedValueOnce({ transactions: [tx('r2')], pageCount: 2 });
      paymentRepository.findLedgerAttempts.mockResolvedValue([ledger('r1', 'CAPTURED'), ledger('r2', 'CAPTURED')]);

      const summary = await service.diffPreviousDay(NOW);

      expect(paystack.listTransactions.mock.calls).toEqual([
        [{ from: DAY_START, to: DAY_END, status: 'success', page: 1, perPage: 100 }],
        [{ from: DAY_START, to: DAY_END, status: 'success', page: 2, perPage: 100 }],
      ]);
      expect(paymentRepository.findLedgerAttempts).toHaveBeenCalledWith(['r1', 'r2']);
      expect(summary).toMatchObject({ day: '2026-11-17', paystackSuccesses: 2, complete: true, recovered: 0 });
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(
        expect.stringContaining('Payment reconciliation diff | day: 2026-11-17 | paystack successes: 2'),
        'PaymentReconciliation',
      );
    });

    it('stops at the page cap and reports the diff as incomplete', async () => {
      paystack.listTransactions.mockImplementation(async ({ page }: { page: number }) => ({
        transactions: [tx(`r${page}`)],
        pageCount: DIFF_MAX_PAGES + 5,
      }));
      paymentRepository.findLedgerAttempts.mockImplementation(async (references: string[]) =>
        references.map((reference) => ledger(reference, 'CAPTURED')),
      );

      const summary = await service.diffPreviousDay(NOW);

      expect(paystack.listTransactions).toHaveBeenCalledTimes(DIFF_MAX_PAGES);
      expect(summary?.complete).toBe(false);
      expect(errorLines()).toEqual([
        expect.stringContaining('Payment reconciliation diff truncated'),
        expect.stringContaining('complete: false'),
      ]);
    });

    it('logs each mismatch, settles a missed success and summarises at error level', async () => {
      paystack.listTransactions.mockResolvedValue({
        transactions: [tx('unknown'), tx('missed'), tx('failed'), tx('short', 9000)],
        pageCount: 1,
      });
      paymentRepository.findLedgerAttempts.mockResolvedValue([
        ledger('missed', 'PENDING'),
        ledger('failed', 'FAILED'),
        ledger('short', 'CAPTURED'),
      ]);
      paymentService.verifyPayment.mockResolvedValue({ status: 'CAPTURED' });

      const summary = await service.diffPreviousDay(NOW);

      expect(paymentService.verifyPayment.mock.calls).toEqual([['missed']]);
      expect(summary).toMatchObject({
        mismatches: { PAYSTACK_ONLY: 1, UNSETTLED: 1, STATUS_MISMATCH: 1, AMOUNT_MISMATCH: 1 },
        recovered: 1,
      });
      expect(errorLines()).toEqual([
        'Payment reconciliation mismatch | kind: PAYSTACK_ONLY | reference: unknown | paystack: 10000 GHS | ledger: none',
        'Payment reconciliation mismatch | kind: UNSETTLED | reference: missed | paystack: 10000 GHS | ledger: PENDING 10000 GHS',
        'Payment reconciliation mismatch | kind: STATUS_MISMATCH | reference: failed | paystack: 10000 GHS | ledger: FAILED 10000 GHS',
        'Payment reconciliation mismatch | kind: AMOUNT_MISMATCH | reference: short | paystack: 9000 GHS | ledger: CAPTURED 10000 GHS',
        expect.stringContaining(
          'PAYSTACK_ONLY: 1 | UNSETTLED: 1 | STATUS_MISMATCH: 1 | AMOUNT_MISMATCH: 1 | recovered: 1 | complete: true',
        ),
      ]);
    });

    it('keeps diffing when a missed success cannot be settled', async () => {
      paystack.listTransactions.mockResolvedValue({ transactions: [tx('m1'), tx('m2')], pageCount: 1 });
      paymentRepository.findLedgerAttempts.mockResolvedValue([ledger('m1', 'PENDING'), ledger('m2', 'CANCELLED')]);
      paymentService.verifyPayment
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ status: 'CAPTURED' });

      const summary = await service.diffPreviousDay(NOW);

      expect(paymentService.verifyPayment).toHaveBeenCalledTimes(2);
      expect(summary?.recovered).toBe(1);
      expect(errorLines()).toContainEqual(
        expect.stringContaining('Missed payment could not be settled | reference: m1'),
      );
    });

    it('does not query the ledger when Paystack has no successes for the day', async () => {
      const summary = await service.diffPreviousDay(NOW);

      expect(paymentRepository.findLedgerAttempts).not.toHaveBeenCalled();
      expect(summary).toMatchObject({ paystackSuccesses: 0, complete: true });
    });
  });
});
