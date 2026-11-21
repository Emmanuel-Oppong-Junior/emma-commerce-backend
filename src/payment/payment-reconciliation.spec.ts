import { Prisma } from '../generated/prisma/client';
import {
  diffSuccessfulTransactions,
  LedgerAttempt,
  previousUtcDay,
  staleAttemptWindow,
} from './payment-reconciliation';

const success = (reference: string, amount = 10000, currency = 'GHS') => ({
  reference,
  status: 'success',
  amount,
  currency,
});

const attempt = (reference: string, overrides: Partial<LedgerAttempt> = {}): LedgerAttempt => ({
  reference,
  status: 'CAPTURED',
  amount: new Prisma.Decimal(100),
  currency: 'GHS',
  reviewReason: null,
  ...overrides,
});

describe('payment reconciliation rules', () => {
  describe('staleAttemptWindow', () => {
    it('covers attempts created between 24 hours and 15 minutes before now', () => {
      const now = new Date('2026-11-18T12:00:00.000Z');

      expect(staleAttemptWindow(now)).toEqual({
        createdFrom: new Date('2026-11-17T12:00:00.000Z'),
        createdBefore: new Date('2026-11-18T11:45:00.000Z'),
      });
    });
  });

  describe('previousUtcDay', () => {
    it.each([
      ['early morning', '2026-11-18T01:30:00.000Z'],
      ['late evening', '2026-11-18T23:59:59.999Z'],
    ])('is the whole previous UTC day when run in the %s', (_label, now) => {
      expect(previousUtcDay(new Date(now))).toEqual({
        from: new Date('2026-11-17T00:00:00.000Z'),
        to: new Date('2026-11-18T00:00:00.000Z'),
      });
    });

    it('crosses month and year boundaries', () => {
      expect(previousUtcDay(new Date('2027-01-01T01:30:00.000Z')).from).toEqual(new Date('2026-12-31T00:00:00.000Z'));
    });
  });

  describe('diffSuccessfulTransactions', () => {
    it('reports nothing when every success matches a completed attempt', () => {
      expect(diffSuccessfulTransactions([success('r1')], [attempt('r1')])).toEqual([]);
    });

    it('reports a Paystack success we have no attempt for', () => {
      expect(diffSuccessfulTransactions([success('r1')], [])).toEqual([
        { kind: 'PAYSTACK_ONLY', transaction: success('r1') },
      ]);
    });

    it.each(['PENDING', 'CANCELLED'] as const)('reports a success whose attempt is still %s as unsettled', (status) => {
      const open = attempt('r1', { status });

      expect(diffSuccessfulTransactions([success('r1')], [open])).toEqual([
        { kind: 'UNSETTLED', transaction: success('r1'), attempt: open },
      ]);
    });

    it('reports a success whose attempt failed without a review flag', () => {
      const failed = attempt('r1', { status: 'FAILED' });

      expect(diffSuccessfulTransactions([success('r1')], [failed])).toEqual([
        { kind: 'STATUS_MISMATCH', transaction: success('r1'), attempt: failed },
      ]);
    });

    it.each([
      ['amount', success('r1', 9999)],
      ['currency', success('r1', 10000, 'NGN')],
    ])('reports a completed attempt whose %s differs from Paystack', (_label, transaction) => {
      expect(diffSuccessfulTransactions([transaction], [attempt('r1')])).toEqual([
        { kind: 'AMOUNT_MISMATCH', transaction, attempt: attempt('r1') },
      ]);
    });

    it('does not report attempts already flagged for review', () => {
      const attempts = [
        attempt('r1', { status: 'FAILED', reviewReason: 'AMOUNT_MISMATCH' }),
        attempt('r2', { reviewReason: 'ORDER_NOT_PAYABLE' }),
      ];

      expect(diffSuccessfulTransactions([success('r1', 9999), success('r2')], attempts)).toEqual([]);
    });

    it('ignores non-success transactions and counts a reference listed twice once', () => {
      const abandoned = { ...success('r2'), status: 'abandoned' };

      expect(diffSuccessfulTransactions([success('r1'), success('r1'), abandoned], [])).toEqual([
        { kind: 'PAYSTACK_ONLY', transaction: success('r1') },
      ]);
    });
  });
});
