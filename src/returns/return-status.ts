import { ConflictException } from '@nestjs/common';
import { ReturnStatus } from '../generated/prisma/client';

const R = ReturnStatus;

/**
 * The return machine (P6-R.1): REQUESTED -> APPROVED (or REJECTED) -> RECEIVED (goods back, per line quantity received)
 * -> INSPECTED (per line restock / write-off) -> REFUND_PENDING (refund recorded, being sent) -> REFUNDED, or straight
 * to REFUNDED for a cash refund, or EXCHANGED (replacement order). The customer may cancel before RECEIVED; staff may
 * reject an approved return whose goods never came back. APPROVED -> REFUND_PENDING is the refund of a legacy
 * whole-order request (no lines), which skips receipt and inspection.
 */
const TRANSITIONS: Record<ReturnStatus, ReturnStatus[]> = {
  REQUESTED: [R.APPROVED, R.REJECTED, R.CANCELLED],
  APPROVED: [R.RECEIVED, R.REJECTED, R.CANCELLED, R.REFUND_PENDING],
  RECEIVED: [R.INSPECTED],
  INSPECTED: [R.REFUND_PENDING, R.REFUNDED, R.EXCHANGED],
  REFUND_PENDING: [R.REFUNDED],
  REJECTED: [],
  REFUNDED: [],
  EXCHANGED: [],
  CANCELLED: [],
};

/** Before the goods are back the customer may withdraw the request. */
export const CUSTOMER_CANCELLABLE_RETURN: ReturnStatus[] = [R.REQUESTED, R.APPROVED];

/** Staff may refuse a request, or an approved return whose goods never arrived. */
export const REJECTABLE_RETURN: ReturnStatus[] = [R.REQUESTED, R.APPROVED];

/** Returns that no longer claim any units of their order lines. */
export const CLOSED_WITHOUT_RETURN: ReturnStatus[] = [R.REJECTED, R.CANCELLED];

export function canReturnTransition(from: ReturnStatus, to: ReturnStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isReturnFinal(status: ReturnStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** CONFLICT when the return is not in a status that may move to `to`. */
export function assertReturnTransition(returnRequestId: string, from: ReturnStatus, to: ReturnStatus): void {
  if (!canReturnTransition(from, to)) {
    throw new ConflictException(`Return request "${returnRequestId}" is ${from} and cannot move to ${to}`);
  }
}
