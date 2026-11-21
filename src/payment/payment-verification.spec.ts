import { BadGatewayException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentIntentStatus,
  PaymentReviewReason,
  PaymentStatus,
  Prisma,
} from '../generated/prisma/client';
import {
  AttemptState,
  autoRefundKey,
  decideVerification,
  fromSubunits,
  parseProviderVerification,
  ProviderVerification,
} from './payment-verification';

const open: AttemptState = {
  status: PaymentStatus.PENDING,
  amount: new Prisma.Decimal('150.25'),
  currency: 'GHS',
  intentStatus: PaymentIntentStatus.PENDING,
  order: { status: OrderStatus.PLACED, deleted: false },
};

const success: ProviderVerification = { reference: 'ref1', status: 'success', amount: 15025, currency: 'GHS' };

describe('decideVerification', () => {
  it('pays the order when the provider confirms exactly the attempt amount and currency', () => {
    expect(decideVerification(open, success)).toEqual({ kind: 'paid' });
  });

  it('pays the order from a late success on an abandoned attempt', () => {
    expect(decideVerification({ ...open, status: PaymentStatus.CANCELLED }, success)).toEqual({ kind: 'paid' });
  });

  it.each([PaymentStatus.CAPTURED, PaymentStatus.FAILED])('leaves a %s attempt alone', (status) => {
    expect(decideVerification({ ...open, status }, success)).toEqual({ kind: 'settled' });
  });

  it('fails the attempt when the provider reports a failed charge', () => {
    expect(decideVerification(open, { ...success, status: 'failed' })).toEqual({ kind: 'failed' });
  });

  it.each(['abandoned', 'ongoing', 'pending', 'reversed'])(
    'keeps the attempt open while the provider reports %s',
    (status) => {
      expect(decideVerification(open, { ...success, status })).toEqual({ kind: 'unresolved' });
    },
  );

  it.each([
    ['less', 15024],
    ['more', 15026],
  ])('flags a success for %s than the attempt amount without counting it as payment', (_label, amount) => {
    expect(decideVerification(open, { ...success, amount })).toEqual({
      kind: 'review',
      reason: PaymentReviewReason.AMOUNT_MISMATCH,
      attemptStatus: PaymentStatus.FAILED,
    });
  });

  it('flags a success in another currency without counting it as payment', () => {
    expect(decideVerification(open, { ...success, currency: 'NGN' })).toEqual({
      kind: 'review',
      reason: PaymentReviewReason.CURRENCY_MISMATCH,
      attemptStatus: PaymentStatus.FAILED,
    });
  });

  it('flags a second full payment for an order another attempt already paid', () => {
    const paidElsewhere = {
      ...open,
      intentStatus: PaymentIntentStatus.CAPTURED,
      order: { status: OrderStatus.CONFIRMED, deleted: false },
    };

    expect(decideVerification(paidElsewhere, success)).toEqual({
      kind: 'review',
      reason: PaymentReviewReason.ALREADY_PAID,
      attemptStatus: PaymentStatus.CAPTURED,
    });
  });

  it.each([OrderStatus.CANCELLED, OrderStatus.CONFIRMED, OrderStatus.IN_FULFILMENT, OrderStatus.COMPLETED])(
    'flags a success for a %s order instead of moving it',
    (status) => {
      expect(decideVerification({ ...open, order: { status, deleted: false } }, success)).toEqual({
        kind: 'review',
        reason: PaymentReviewReason.ORDER_NOT_PAYABLE,
        attemptStatus: PaymentStatus.CAPTURED,
      });
    },
  );

  it('flags a success for a deleted order', () => {
    expect(decideVerification({ ...open, order: { status: OrderStatus.PLACED, deleted: true } }, success)).toEqual({
      kind: 'review',
      reason: PaymentReviewReason.ORDER_NOT_PAYABLE,
      attemptStatus: PaymentStatus.CAPTURED,
    });
  });
});

describe('parseProviderVerification', () => {
  it('accepts a success carrying an integer amount and a currency', () => {
    expect(
      parseProviderVerification('ref1', { reference: 'ref1', status: 'success', amount: 100, currency: 'GHS' }),
    ).toEqual({ reference: 'ref1', status: 'success', amount: 100, currency: 'GHS' });
  });

  it('accepts a non-success status without an amount', () => {
    expect(parseProviderVerification('ref1', { reference: 'ref1', status: 'failed' })).toMatchObject({
      status: 'failed',
    });
  });

  it.each([
    ['another reference', { reference: 'ref2', status: 'success', amount: 100, currency: 'GHS' }],
    ['no status', { reference: 'ref1', amount: 100, currency: 'GHS' }],
    ['a fractional amount', { reference: 'ref1', status: 'success', amount: 100.5, currency: 'GHS' }],
    ['an amount as text', { reference: 'ref1', status: 'success', amount: '100', currency: 'GHS' }],
    ['no currency', { reference: 'ref1', status: 'success', amount: 100 }],
  ])('rejects a response with %s', (_label, data) => {
    expect(() => parseProviderVerification('ref1', data)).toThrow(BadGatewayException);
  });

  it('rejects a missing response body', () => {
    expect(() => parseProviderVerification('ref1', undefined)).toThrow(BadGatewayException);
  });
});

describe('fromSubunits', () => {
  it('converts pesewas to cedis without float error', () => {
    expect(fromSubunits(1999).toString()).toBe('19.99');
    expect(fromSubunits(435).toString()).toBe('4.35');
  });
});

describe('autoRefundKey', () => {
  it('is the same for the same attempt so a replay cannot queue a second refund', () => {
    expect(autoRefundKey('pay1')).toBe(autoRefundKey('pay1'));
    expect(autoRefundKey('pay1')).not.toBe(autoRefundKey('pay2'));
  });
});
