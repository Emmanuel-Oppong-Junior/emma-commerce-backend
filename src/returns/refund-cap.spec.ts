import { BadRequestException } from '@nestjs/common';
import { PaymentProvider, PaymentStatus, Prisma, RefundStatus } from '@prisma/client';
import { assertRefundable, capturedAmount, RefundLedger } from './refund-cap';

const d = (value: string | number) => new Prisma.Decimal(value);

const ledgerWith = (
  refunds: { id: string; amount: string; status: RefundStatus; idempotencyKey?: string }[],
  attempt: Partial<RefundLedger['attempt']> = {},
): RefundLedger => ({
  attempt: {
    id: 'attempt1',
    status: PaymentStatus.COMPLETED,
    provider: PaymentProvider.PAYSTACK,
    reference: 'ref1',
    amount: d('100.00'),
    currency: 'GHS',
    ...attempt,
  },
  refunds: refunds.map((r) => ({ ...r, amount: d(r.amount), idempotencyKey: r.idempotencyKey ?? `key-${r.id}` })),
});

describe('refund cap', () => {
  it('allows refunds up to exactly the captured amount, summed in Decimal', () => {
    const ledger = ledgerWith([
      { id: 'r1', amount: '33.33', status: RefundStatus.PROCESSED },
      { id: 'r2', amount: '33.33', status: RefundStatus.PENDING },
    ]);

    expect(() => assertRefundable(ledger, { amount: d('33.34') })).not.toThrow();
    expect(() => assertRefundable(ledger, { amount: d('33.35') })).toThrow(
      'Refund of 33.35 GHS exceeds the 33.34 GHS still refundable on payment "attempt1"',
    );
  });

  it('counts a SENDING refund, whose outcome may be unknown, but not a FAILED one, which moved no money', () => {
    const ledger = ledgerWith([
      { id: 'r1', amount: '60.00', status: RefundStatus.SENDING },
      { id: 'r2', amount: '40.00', status: RefundStatus.FAILED },
    ]);

    expect(() => assertRefundable(ledger, { amount: d('40.00') })).not.toThrow();
    expect(() => assertRefundable(ledger, { amount: d('40.01') })).toThrow(BadRequestException);
  });

  it('leaves the refund being re-checked out of the committed total', () => {
    const ledger = ledgerWith([{ id: 'r1', amount: '100.00', status: RefundStatus.FAILED }]);

    expect(() => assertRefundable(ledger, { id: 'r1', amount: d('100.00') })).not.toThrow();
  });

  it('refuses a refund once an auto-refund has returned the whole payment', () => {
    const ledger = ledgerWith([
      { id: 'auto', amount: '100.00', status: RefundStatus.PROCESSED, idempotencyKey: 'auto-refund:attempt1' },
    ]);

    expect(() => assertRefundable(ledger, { amount: d('0.01') })).toThrow(
      'exceeds the 0.00 GHS still refundable on payment "attempt1"',
    );
  });

  it('caps a charge flagged for a wrong amount at what its auto-refund recorded, not at the attempt amount', () => {
    const ledger = ledgerWith(
      [{ id: 'auto', amount: '1.00', status: RefundStatus.PENDING, idempotencyKey: 'auto-refund:attempt1' }],
      { status: PaymentStatus.FAILED },
    );

    expect(capturedAmount(ledger)).toEqual(d('1.00'));
    expect(() => assertRefundable(ledger, { id: 'auto', amount: d('1.00') })).not.toThrow();
    expect(() => assertRefundable(ledger, { amount: d('0.01') })).toThrow(BadRequestException);
  });

  it('treats an attempt that captured nothing as having nothing to refund', () => {
    expect(capturedAmount(ledgerWith([], { status: PaymentStatus.FAILED }))).toEqual(d(0));
  });

  it('refuses a zero amount', () => {
    expect(() => assertRefundable(ledgerWith([]), { amount: d(0) })).toThrow('Refund amount must be greater than 0');
  });

  it('refuses a payment that Paystack cannot refund', () => {
    const cod = ledgerWith([], { provider: PaymentProvider.CASH_ON_DELIVERY, reference: null });

    expect(() => assertRefundable(cod, { amount: d(10) })).toThrow('cannot be refunded through Paystack');
  });
});
