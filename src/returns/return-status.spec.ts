import { ConflictException } from '@nestjs/common';
import { ReturnStatus } from '../generated/prisma/client';
import { assertReturnTransition, canReturnTransition, isReturnFinal } from './return-status';

const { REQUESTED, APPROVED, REJECTED, RECEIVED, INSPECTED, REFUND_PENDING, REFUNDED, EXCHANGED, CANCELLED } =
  ReturnStatus;

const ALLOWED: [ReturnStatus, ReturnStatus][] = [
  [REQUESTED, APPROVED],
  [REQUESTED, REJECTED],
  [REQUESTED, CANCELLED],
  [APPROVED, RECEIVED],
  [APPROVED, REJECTED],
  [APPROVED, CANCELLED],
  [APPROVED, REFUND_PENDING],
  [RECEIVED, INSPECTED],
  [INSPECTED, REFUND_PENDING],
  [INSPECTED, REFUNDED],
  [INSPECTED, EXCHANGED],
  [REFUND_PENDING, REFUNDED],
];

const ALL_PAIRS = Object.values(ReturnStatus).flatMap((from) =>
  Object.values(ReturnStatus).map((to) => [from, to] as [ReturnStatus, ReturnStatus]),
);

describe('return status transitions', () => {
  it.each(ALL_PAIRS)('%s → %s matches the table', (from, to) => {
    expect(canReturnTransition(from, to)).toBe(ALLOWED.some(([f, t]) => f === from && t === to));
  });

  it('treats rejected, refunded, exchanged and cancelled returns as final', () => {
    expect(Object.values(ReturnStatus).filter(isReturnFinal).sort()).toEqual(
      [CANCELLED, EXCHANGED, REFUNDED, REJECTED].sort(),
    );
  });

  it('refuses a move the table does not allow with CONFLICT naming both statuses', () => {
    expect(() => assertReturnTransition('rr1', RECEIVED, REFUNDED)).toThrow(ConflictException);
    expect(() => assertReturnTransition('rr1', RECEIVED, REFUNDED)).toThrow(/RECEIVED and cannot move to REFUNDED/);
    expect(() => assertReturnTransition('rr1', REQUESTED, APPROVED)).not.toThrow();
  });
});
