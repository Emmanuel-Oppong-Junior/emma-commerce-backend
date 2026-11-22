import { ConflictException } from '@nestjs/common';
import { DisputeStatus, Prisma, RefundStatus } from '../../generated/prisma/client';
import { assertDisputesAllowRefund, DisputedPayment } from './dispute-refund-guard';

const d = (value: string | number) => new Prisma.Decimal(value);

describe('assertDisputesAllowRefund', () => {
  const payment = (
    disputes: { status: DisputeStatus; amount: number }[],
    refunds: { status: RefundStatus; amount: number }[] = [],
  ): DisputedPayment => ({
    attemptId: 'pay-1',
    currency: 'GHS',
    captured: d(100),
    disputes: disputes.map((dispute, i) => ({ id: `dsp-${i}`, status: dispute.status, amount: d(dispute.amount) })),
    refunds: refunds.map((refund, i) => ({ id: `ref-${i}`, status: refund.status, amount: d(refund.amount) })),
  });
  const refund = (amount: number) => ({ id: 'new-refund', amount: d(amount) });
  const reasonOf = (work: () => void) => {
    try {
      work();
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return ((error as ConflictException).getResponse() as { extensions: { reason: string } }).extensions.reason;
    }
    return undefined;
  };

  it('allows a refund on a payment without disputes or with a dispute the merchant WON', () => {
    expect(() => assertDisputesAllowRefund(payment([]), refund(100))).not.toThrow();
    expect(() => assertDisputesAllowRefund(payment([{ status: 'WON', amount: 100 }]), refund(100))).not.toThrow();
  });

  it.each<DisputeStatus>(['OPEN', 'AWAITING_EVIDENCE', 'UNDER_REVIEW'])(
    'refuses any refund while a dispute is %s (CONFLICT, PAYMENT_DISPUTED)',
    (status) => {
      expect(reasonOf(() => assertDisputesAllowRefund(payment([{ status, amount: 10 }]), refund(1)))).toBe(
        'PAYMENT_DISPUTED',
      );
    },
  );

  it.each<DisputeStatus>(['LOST', 'ACCEPTED'])(
    'counts a %s dispute as charged back: only what is left after it and earlier refunds can be refunded',
    (status) => {
      const charged = payment(
        [{ status, amount: 60 }],
        [
          { status: 'PROCESSED', amount: 20 },
          { status: 'FAILED', amount: 50 },
        ],
      );

      expect(() => assertDisputesAllowRefund(charged, refund(20))).not.toThrow();
      expect(reasonOf(() => assertDisputesAllowRefund(charged, refund(20.01)))).toBe('PAYMENT_DISPUTED');
    },
  );

  it('leaves the refund being re-sent out of the earlier refunds', () => {
    const charged = payment([{ status: 'LOST', amount: 60 }]);
    charged.refunds.push({ id: 'new-refund', status: 'SENDING', amount: d(40) });

    expect(() => assertDisputesAllowRefund(charged, refund(40))).not.toThrow();
  });
});
