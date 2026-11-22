import { ConflictException } from '@nestjs/common';
import { DisputeStatus } from '../../generated/prisma/client';

/*
 * OPEN: the provider (or staff) logged it. AWAITING_EVIDENCE: the merchant must answer by the due date. UNDER_REVIEW:
 * evidence is with the bank, which may ask for more. WON: the bank decided for the merchant. LOST: decided for the
 * customer. ACCEPTED: the merchant accepted the claim. LOST and ACCEPTED both mean the money went back to the customer.
 */
const TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> = {
  OPEN: ['AWAITING_EVIDENCE', 'UNDER_REVIEW', 'WON', 'LOST', 'ACCEPTED'],
  AWAITING_EVIDENCE: ['UNDER_REVIEW', 'WON', 'LOST', 'ACCEPTED'],
  UNDER_REVIEW: ['AWAITING_EVIDENCE', 'WON', 'LOST', 'ACCEPTED'],
  WON: [],
  LOST: [],
  ACCEPTED: [],
};

export const UNRESOLVED_DISPUTE_STATUSES: readonly DisputeStatus[] = ['OPEN', 'AWAITING_EVIDENCE', 'UNDER_REVIEW'];

/** Resolved against the merchant: the disputed amount went back to the customer through the bank. */
export const CHARGED_BACK_DISPUTE_STATUSES: readonly DisputeStatus[] = ['LOST', 'ACCEPTED'];

export function canDisputeTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isDisputeResolved(status: DisputeStatus): boolean {
  return !UNRESOLVED_DISPUTE_STATUSES.includes(status);
}

export function assertDisputeTransition(from: DisputeStatus, to: DisputeStatus): void {
  if (!canDisputeTransition(from, to)) {
    throw new ConflictException(`A dispute cannot move from ${from} to ${to}`);
  }
}
