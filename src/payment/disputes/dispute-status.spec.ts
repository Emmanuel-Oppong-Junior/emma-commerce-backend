import { ConflictException } from '@nestjs/common';
import { DisputeStatus } from '../../generated/prisma/client';
import { assertDisputeTransition, canDisputeTransition, isDisputeResolved } from './dispute-status';

describe('dispute status transitions', () => {
  it.each<[DisputeStatus, DisputeStatus]>([
    ['OPEN', 'AWAITING_EVIDENCE'],
    ['OPEN', 'UNDER_REVIEW'],
    ['OPEN', 'ACCEPTED'],
    ['AWAITING_EVIDENCE', 'UNDER_REVIEW'],
    ['UNDER_REVIEW', 'AWAITING_EVIDENCE'],
    ['UNDER_REVIEW', 'WON'],
    ['UNDER_REVIEW', 'LOST'],
    ['AWAITING_EVIDENCE', 'ACCEPTED'],
  ])('allows %s -> %s', (from, to) => {
    expect(canDisputeTransition(from, to)).toBe(true);
    expect(() => assertDisputeTransition(from, to)).not.toThrow();
  });

  it.each<[DisputeStatus, DisputeStatus]>([
    ['WON', 'LOST'],
    ['LOST', 'OPEN'],
    ['ACCEPTED', 'UNDER_REVIEW'],
    ['AWAITING_EVIDENCE', 'OPEN'],
    ['UNDER_REVIEW', 'OPEN'],
    ['OPEN', 'OPEN'],
  ])('refuses %s -> %s with CONFLICT', (from, to) => {
    expect(canDisputeTransition(from, to)).toBe(false);
    expect(() => assertDisputeTransition(from, to)).toThrow(ConflictException);
  });

  it('treats WON, LOST and ACCEPTED as resolved, the rest as unresolved', () => {
    expect(['OPEN', 'AWAITING_EVIDENCE', 'UNDER_REVIEW'].map((s) => isDisputeResolved(s as DisputeStatus))).toEqual([
      false,
      false,
      false,
    ]);
    expect(['WON', 'LOST', 'ACCEPTED'].map((s) => isDisputeResolved(s as DisputeStatus))).toEqual([true, true, true]);
  });
});
