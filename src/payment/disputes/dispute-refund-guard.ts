import { ConflictException } from '@nestjs/common';
import { DisputeStatus, Prisma, RefundStatus } from '../../generated/prisma/client';
import { CHARGED_BACK_DISPUTE_STATUSES, UNRESOLVED_DISPUTE_STATUSES } from './dispute-status';

export const PAYMENT_DISPUTED = 'PAYMENT_DISPUTED';

export interface DisputedPayment {
  attemptId: string;
  currency: string;
  /** What the payment captured (refund-cap's capturedAmount). */
  captured: Prisma.Decimal;
  disputes: { id: string; status: DisputeStatus; amount: Prisma.Decimal }[];
  /** The payment's other refunds. */
  refunds: { id: string; status: RefundStatus; amount: Prisma.Decimal }[];
}

/** A FAILED refund was refused by the provider and moved no money. */
const MONEY_MOVING_REFUNDS: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.SENDING, RefundStatus.PROCESSED];

/**
 * Refuses (CONFLICT, reason PAYMENT_DISPUTED) a refund on a payment with an unresolved dispute: the bank may still
 * return the money, and refunding as well would pay the customer twice. A dispute the merchant LOST or ACCEPTED has
 * already returned its amount, so it counts like a refund: what remains refundable is the captured amount minus the
 * charged-back amount and the other refunds.
 */
export function assertDisputesAllowRefund(
  payment: DisputedPayment,
  refund: { id?: string; amount: Prisma.Decimal },
): void {
  const open = payment.disputes.find((dispute) => UNRESOLVED_DISPUTE_STATUSES.includes(dispute.status));
  if (open) {
    throw new ConflictException({
      message: `Payment "${payment.attemptId}" has an unresolved dispute ("${open.id}", ${open.status}); refunds wait until it is resolved`,
      extensions: { reason: PAYMENT_DISPUTED },
    });
  }
  const chargedBack = sum(payment.disputes.filter((dispute) => CHARGED_BACK_DISPUTE_STATUSES.includes(dispute.status)));
  if (chargedBack.isZero()) return;
  const refunded = sum(
    payment.refunds.filter((other) => other.id !== refund.id && MONEY_MOVING_REFUNDS.includes(other.status)),
  );
  const remaining = Prisma.Decimal.max(payment.captured.sub(chargedBack).sub(refunded), 0);
  if (refund.amount.gt(remaining)) {
    throw new ConflictException({
      message: `Refund of ${refund.amount.toFixed(2)} ${payment.currency} exceeds the ${remaining.toFixed(2)} ${payment.currency} left on payment "${payment.attemptId}" after ${chargedBack.toFixed(2)} ${payment.currency} was charged back`,
      extensions: { reason: PAYMENT_DISPUTED },
    });
  }
}

function sum(rows: { amount: Prisma.Decimal }[]): Prisma.Decimal {
  return rows.reduce((total, row) => total.add(row.amount), new Prisma.Decimal(0));
}
