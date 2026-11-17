import { BadGatewayException } from '@nestjs/common';
import { OrderStatus, PaymentIntentStatus, PaymentReviewReason, PaymentStatus, Prisma } from '@prisma/client';

/** The provider's verdict on one transaction, checked at the boundary. `amount` is in subunits (pesewas). */
export interface ProviderVerification {
  reference: string;
  status: string;
  amount: number;
  currency: string;
}

/** The locked ledger and order state a verification is decided against. */
export interface AttemptState {
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
  intentStatus: PaymentIntentStatus;
  order: { status: OrderStatus; deleted: boolean };
}

export type VerificationOutcome =
  | { kind: 'settled' }
  | { kind: 'unresolved' }
  | { kind: 'failed' }
  | { kind: 'paid' }
  | { kind: 'review'; reason: PaymentReviewReason; attemptStatus: ReviewedAttemptStatus };

/** A wrong amount or currency never counts as payment; a correct charge the order cannot take stays COMPLETED. */
export type ReviewedAttemptStatus = typeof PaymentStatus.COMPLETED | typeof PaymentStatus.FAILED;

const PROVIDER_SUCCESS = 'success';
const PROVIDER_FAILED = 'failed';
const OPEN_ATTEMPT_STATUSES: PaymentStatus[] = [PaymentStatus.PENDING, PaymentStatus.ABANDONED];

export function isSettled(status: PaymentStatus): boolean {
  return !OPEN_ATTEMPT_STATUSES.includes(status);
}

/** Rejects a provider response that cannot be trusted to settle the attempt for `reference`. */
export function parseProviderVerification(
  reference: string,
  data: { reference?: unknown; status?: unknown; amount?: unknown; currency?: unknown } | undefined,
): ProviderVerification {
  if (data?.reference !== reference) {
    throw new BadGatewayException(
      `Payment provider answered for reference "${String(data?.reference)}" instead of "${reference}"`,
    );
  }
  if (typeof data.status !== 'string') {
    throw new BadGatewayException(`Payment provider returned no status for reference "${reference}"`);
  }
  if (data.status !== PROVIDER_SUCCESS) {
    return { reference, status: data.status, amount: 0, currency: '' };
  }
  if (!Number.isSafeInteger(data.amount) || typeof data.currency !== 'string') {
    throw new BadGatewayException(
      `Payment provider returned a success without a valid amount and currency for reference "${reference}"`,
    );
  }
  return { reference, status: data.status, amount: data.amount as number, currency: data.currency };
}

/**
 * Decides what a provider verdict means for an attempt. Money is accepted as payment for the order only when the
 * provider reports success for exactly the attempt's amount and currency, the order is still PENDING and nothing
 * else has paid it. Any other captured charge is kept on the ledger and flagged for review and refund.
 */
export function decideVerification(state: AttemptState, verified: ProviderVerification): VerificationOutcome {
  if (isSettled(state.status)) return { kind: 'settled' };
  if (verified.status === PROVIDER_FAILED) return { kind: 'failed' };
  if (verified.status !== PROVIDER_SUCCESS) return { kind: 'unresolved' };

  if (verified.currency !== state.currency) {
    return { kind: 'review', reason: PaymentReviewReason.CURRENCY_MISMATCH, attemptStatus: PaymentStatus.FAILED };
  }
  if (!toSubunits(state.amount).equals(verified.amount)) {
    return { kind: 'review', reason: PaymentReviewReason.AMOUNT_MISMATCH, attemptStatus: PaymentStatus.FAILED };
  }
  if (state.intentStatus === PaymentIntentStatus.PAID) {
    return { kind: 'review', reason: PaymentReviewReason.ALREADY_PAID, attemptStatus: PaymentStatus.COMPLETED };
  }
  if (state.order.deleted || state.order.status !== OrderStatus.PENDING) {
    return { kind: 'review', reason: PaymentReviewReason.ORDER_NOT_PAYABLE, attemptStatus: PaymentStatus.COMPLETED };
  }
  return { kind: 'paid' };
}

function toSubunits(amount: Prisma.Decimal): Prisma.Decimal {
  return amount.mul(100);
}

export function fromSubunits(subunits: number): Prisma.Decimal {
  return new Prisma.Decimal(subunits).div(100);
}

export function autoRefundKey(attemptId: string): string {
  return `auto-refund:${attemptId}`;
}
