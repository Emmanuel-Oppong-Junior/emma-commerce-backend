import { BadRequestException } from '@nestjs/common';
import { PaymentProvider, PaymentStatus, Prisma, Refund, RefundStatus } from '../generated/prisma/client';
import { autoRefundKey } from '../payment/payment-verification';

/** A payment attempt and every refund recorded against it, read under the attempt's row lock. */
export interface RefundLedger {
  attempt: {
    id: string;
    status: PaymentStatus;
    provider: PaymentProvider;
    reference: string | null;
    amount: Prisma.Decimal;
    currency: string;
  };
  refunds: Pick<Refund, 'id' | 'amount' | 'status' | 'idempotencyKey'>[];
}

/** Refunds that have moved money or may still move it. A FAILED refund was refused by the provider and moved none. */
const COMMITTED_REFUND_STATUSES: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.SENDING, RefundStatus.PROCESSED];

/**
 * What the provider captured on the attempt: the attempt amount once it completed. A charge flagged for review
 * (wrong amount or currency) never completed; the only money it can return is what its auto-refund recorded.
 */
export function capturedAmount(ledger: RefundLedger): Prisma.Decimal {
  if (ledger.attempt.status === PaymentStatus.CAPTURED) return ledger.attempt.amount;
  const autoRefund = ledger.refunds.find((refund) => refund.idempotencyKey === autoRefundKey(ledger.attempt.id));
  return autoRefund?.amount ?? new Prisma.Decimal(0);
}

/**
 * Refuses a refund that Paystack cannot send or that would take the attempt's committed refunds above what it
 * captured. `refund.id` is left out of the committed total so an existing refund can be re-checked before resending.
 */
export function assertRefundable(ledger: RefundLedger, refund: { id?: string; amount: Prisma.Decimal }): void {
  const { attempt } = ledger;
  if (attempt.provider !== PaymentProvider.PAYSTACK || !attempt.reference) {
    throw new BadRequestException(
      `Payment "${attempt.id}" is a ${attempt.provider} payment without a Paystack reference and cannot be refunded through Paystack`,
    );
  }
  if (refund.amount.lte(0)) {
    throw new BadRequestException(`Refund amount must be greater than 0, got ${refund.amount.toFixed(2)}`);
  }
  const committed = ledger.refunds
    .filter((other) => other.id !== refund.id && COMMITTED_REFUND_STATUSES.includes(other.status))
    .reduce((sum, other) => sum.add(other.amount), new Prisma.Decimal(0));
  const remaining = capturedAmount(ledger).sub(committed);
  if (refund.amount.gt(remaining)) {
    throw new BadRequestException(
      `Refund of ${refund.amount.toFixed(2)} ${attempt.currency} exceeds the ${Prisma.Decimal.max(remaining, 0).toFixed(2)} ${attempt.currency} still refundable on payment "${attempt.id}"`,
    );
  }
}
