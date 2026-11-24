import { BadRequestException } from '@nestjs/common';
import { RefundReason, RefundStatus } from '../generated/prisma/client';

/** What the customer reads for each reason (email, their order's refunds). */
export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  CUSTOMER_REQUEST: 'Requested by you',
  DAMAGED: 'Item arrived damaged',
  WRONG_ITEM: 'Wrong item sent',
  NOT_DELIVERED: 'Not delivered',
  PRICE_ADJUSTMENT: 'Price adjustment',
  DUPLICATE_CHARGE: 'Duplicate charge',
  OTHER: 'Other',
  RETURN: 'Returned items',
  PAYMENT_NOT_ACCEPTED: 'Payment could not be accepted',
  ORDER_CANCELLED: 'Order cancelled',
};

/**
 * RETURN, PAYMENT_NOT_ACCEPTED and ORDER_CANCELLED are set by the returns flow, payment verification and order
 * cancellation, never chosen by staff.
 */
export const STAFF_REFUND_REASONS: RefundReason[] = [
  RefundReason.CUSTOMER_REQUEST,
  RefundReason.DAMAGED,
  RefundReason.WRONG_ITEM,
  RefundReason.NOT_DELIVERED,
  RefundReason.PRICE_ADJUSTMENT,
  RefundReason.DUPLICATE_CHARGE,
  RefundReason.OTHER,
];

/** Checks a staff refund's reason and note and returns the note to store (trimmed, null when blank). */
export function staffRefundNote(reason: RefundReason, note: string | null | undefined): string | null {
  if (!STAFF_REFUND_REASONS.includes(reason)) {
    throw new BadRequestException(
      `Refund reason ${reason} is set by the system; choose one of ${STAFF_REFUND_REASONS.join(', ')}`,
    );
  }
  const trimmed = note?.trim() || null;
  if (reason === RefundReason.OTHER && !trimmed) {
    throw new BadRequestException('A note is required when the refund reason is OTHER');
  }
  return trimmed;
}

/** What the customer sees of a refund's progress: a refused send is retried by staff, so it still reads as pending. */
export function customerRefundStatus(status: RefundStatus): 'PENDING' | 'REFUNDED' {
  return status === RefundStatus.PROCESSED ? 'REFUNDED' : 'PENDING';
}
