import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';
import { allowedFrom, assertTransition, canTransition, isFinal } from './order-status';

const { PLACED, CONFIRMED, IN_FULFILMENT, COMPLETED, CANCELLED, EXPIRED, PAYMENT_REVIEW } = OrderStatus;

const ALLOWED: [OrderStatus, OrderStatus][] = [
  [PLACED, CONFIRMED],
  [PLACED, CANCELLED],
  [PLACED, EXPIRED],
  [CONFIRMED, IN_FULFILMENT],
  [CONFIRMED, CANCELLED],
  [IN_FULFILMENT, COMPLETED],
  [IN_FULFILMENT, CANCELLED],
  [CANCELLED, PAYMENT_REVIEW],
  [EXPIRED, PAYMENT_REVIEW],
  [PAYMENT_REVIEW, CANCELLED],
];

const ALL_PAIRS = Object.values(OrderStatus).flatMap((from) =>
  Object.values(OrderStatus).map((to) => [from, to] as [OrderStatus, OrderStatus]),
);

describe('order status transitions', () => {
  it.each(ALL_PAIRS)('%s → %s matches the table', (from, to) => {
    const expected = ALLOWED.some(([f, t]) => f === from && t === to);

    expect(canTransition(from, to)).toBe(expected);
  });

  it.each([
    [CONFIRMED, [PLACED]],
    [CANCELLED, [PLACED, CONFIRMED, IN_FULFILMENT, PAYMENT_REVIEW]],
    [EXPIRED, [PLACED]],
    [IN_FULFILMENT, [CONFIRMED]],
    [COMPLETED, [IN_FULFILMENT]],
    [PAYMENT_REVIEW, [CANCELLED, EXPIRED]],
    [PLACED, []],
  ])('lists the statuses an order can move to %s from', (to, from) => {
    expect(allowedFrom(to)).toEqual(from);
  });

  it('has COMPLETED as its only final status', () => {
    expect(Object.values(OrderStatus).filter(isFinal)).toEqual([COMPLETED]);
  });

  it('rejects an invalid transition with CONFLICT naming both statuses', () => {
    expect(() => assertTransition('order-1', CANCELLED, IN_FULFILMENT)).toThrow(
      new ConflictException('Order "order-1" cannot move from CANCELLED to IN_FULFILMENT'),
    );
  });

  it('accepts a valid transition', () => {
    expect(() => assertTransition('order-1', CONFIRMED, IN_FULFILMENT)).not.toThrow();
  });
});
