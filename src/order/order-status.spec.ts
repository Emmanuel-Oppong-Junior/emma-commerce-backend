import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';
import { allowedFrom, assertTransition, canTransition } from './order-status';

const { PENDING, PROCESSING, SHIPPED, DELIVERED, CANCELLED } = OrderStatus;

const ALLOWED: [OrderStatus, OrderStatus][] = [
  [PENDING, PROCESSING],
  [PENDING, CANCELLED],
  [PROCESSING, SHIPPED],
  [PROCESSING, CANCELLED],
  [SHIPPED, DELIVERED],
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
    [PROCESSING, [PENDING]],
    [CANCELLED, [PENDING, PROCESSING]],
    [SHIPPED, [PROCESSING]],
    [DELIVERED, [SHIPPED]],
    [PENDING, []],
  ])('lists the statuses an order can move to %s from', (to, from) => {
    expect(allowedFrom(to)).toEqual(from);
  });

  it('rejects an invalid transition with CONFLICT naming both statuses', () => {
    expect(() => assertTransition('order-1', CANCELLED, SHIPPED)).toThrow(
      new ConflictException('Order "order-1" cannot move from CANCELLED to SHIPPED'),
    );
  });

  it('accepts a valid transition', () => {
    expect(() => assertTransition('order-1', PROCESSING, SHIPPED)).not.toThrow();
  });
});
