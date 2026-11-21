import { PaymentIntentStatus, Prisma } from '../generated/prisma/client';
import { canIntentTransition, intentAllowedFrom, statusAfterRefunds } from './payment-intent-status';

const { PENDING, CAPTURED, PARTIALLY_REFUNDED, REFUNDED, FAILED, CANCELLED } = PaymentIntentStatus;

const ALLOWED: [PaymentIntentStatus, PaymentIntentStatus][] = [
  [PENDING, CAPTURED],
  [PENDING, FAILED],
  [PENDING, CANCELLED],
  [FAILED, PENDING],
  [FAILED, CAPTURED],
  [FAILED, CANCELLED],
  [CAPTURED, PARTIALLY_REFUNDED],
  [CAPTURED, REFUNDED],
  [PARTIALLY_REFUNDED, PARTIALLY_REFUNDED],
  [PARTIALLY_REFUNDED, REFUNDED],
];

const ALL_PAIRS = Object.values(PaymentIntentStatus).flatMap((from) =>
  Object.values(PaymentIntentStatus).map((to) => [from, to] as [PaymentIntentStatus, PaymentIntentStatus]),
);

describe('payment intent status transitions', () => {
  it.each(ALL_PAIRS)('%s → %s matches the table', (from, to) => {
    const expected = ALLOWED.some(([f, t]) => f === from && t === to);

    expect(canIntentTransition(from, to)).toBe(expected);
  });

  it('captures only an open intent', () => {
    expect(intentAllowedFrom(CAPTURED)).toEqual([PENDING, FAILED]);
  });

  it.each([
    ['0', CAPTURED],
    ['0.01', PARTIALLY_REFUNDED],
    ['99.99', PARTIALLY_REFUNDED],
    ['100', REFUNDED],
  ])('after %s of 100 refunded the intent is %s', (refunded, status) => {
    expect(statusAfterRefunds(new Prisma.Decimal(100), new Prisma.Decimal(refunded))).toBe(status);
  });
});
