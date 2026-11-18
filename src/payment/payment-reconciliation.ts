import { PaymentReviewReason, PaymentStatus, Prisma } from '../generated/prisma/client';
import { PAYSTACK_SUCCESS_STATUS } from './constant';
import { isSettled } from './payment-verification';
import { ListedTransaction } from './paystack.client';

/** A webhook normally settles an attempt within seconds; one still open after this is re-verified. */
export const STALE_ATTEMPT_MIN_AGE_MS = 15 * 60 * 1000;
/** Older open attempts are left to the nightly diff, which sees every Paystack success of the day. */
export const STALE_ATTEMPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Our side of one Paystack reference. */
export interface LedgerAttempt {
  reference: string;
  status: PaymentStatus;
  amount: Prisma.Decimal;
  currency: string;
  reviewReason: PaymentReviewReason | null;
}

export type MismatchKind = 'PAYSTACK_ONLY' | 'UNSETTLED' | 'STATUS_MISMATCH' | 'AMOUNT_MISMATCH';

export interface Mismatch {
  kind: MismatchKind;
  transaction: ListedTransaction;
  attempt?: LedgerAttempt;
}

export function staleAttemptWindow(now: Date): { createdFrom: Date; createdBefore: Date } {
  return {
    createdFrom: new Date(now.getTime() - STALE_ATTEMPT_MAX_AGE_MS),
    createdBefore: new Date(now.getTime() - STALE_ATTEMPT_MIN_AGE_MS),
  };
}

/** The UTC calendar day before `now` as [from, to). Ghana keeps UTC all year, so this is also the local day. */
export function previousUtcDay(now: Date): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { from: new Date(to.getTime() - DAY_MS), to };
}

/**
 * Compares Paystack's successful transactions with our attempts for the same references:
 * - PAYSTACK_ONLY: Paystack captured money under a reference we have no attempt for.
 * - UNSETTLED: our attempt is still open, so its webhook was missed; it can be re-verified and settled.
 * - STATUS_MISMATCH: our attempt is settled as not paid and nobody flagged it for review.
 * - AMOUNT_MISMATCH: our completed attempt differs from Paystack in amount or currency and is not under review.
 * An attempt already flagged for review is expected to differ and is not reported again.
 */
export function diffSuccessfulTransactions(transactions: ListedTransaction[], attempts: LedgerAttempt[]): Mismatch[] {
  const attemptsByReference = new Map(attempts.map((attempt) => [attempt.reference, attempt]));
  const successes = new Map(
    transactions
      .filter((transaction) => transaction.status === PAYSTACK_SUCCESS_STATUS)
      .map((transaction) => [transaction.reference, transaction]),
  );

  const mismatches: Mismatch[] = [];
  for (const transaction of successes.values()) {
    const attempt = attemptsByReference.get(transaction.reference);
    const kind = classify(transaction, attempt);
    if (kind) mismatches.push({ kind, transaction, ...(attempt && { attempt }) });
  }
  return mismatches;
}

function classify(transaction: ListedTransaction, attempt: LedgerAttempt | undefined): MismatchKind | null {
  if (!attempt) return 'PAYSTACK_ONLY';
  if (!isSettled(attempt.status)) return 'UNSETTLED';
  if (attempt.reviewReason) return null;
  if (attempt.status !== PaymentStatus.COMPLETED) return 'STATUS_MISMATCH';
  if (attempt.currency !== transaction.currency || !attempt.amount.mul(100).equals(transaction.amount)) {
    return 'AMOUNT_MISMATCH';
  }
  return null;
}
