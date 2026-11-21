import { PaymentIntentStatus, Prisma } from '../generated/prisma/client';

const P = PaymentIntentStatus;

/**
 * The payment machine of an order (ADR-0014), carried by its PaymentIntent. Paystack captures at once, so there is
 * no AUTHORIZED step. FAILED means the last attempt failed; a new attempt reopens the intent and a late success on an
 * older attempt can still capture it. Refund states follow the refunds processed against the accepted capture.
 */
const TRANSITIONS: Record<PaymentIntentStatus, PaymentIntentStatus[]> = {
  PENDING: [P.CAPTURED, P.FAILED, P.CANCELLED],
  FAILED: [P.PENDING, P.CAPTURED, P.CANCELLED],
  CAPTURED: [P.PARTIALLY_REFUNDED, P.REFUNDED],
  PARTIALLY_REFUNDED: [P.PARTIALLY_REFUNDED, P.REFUNDED],
  REFUNDED: [],
  CANCELLED: [],
};

/** The order has been paid (and possibly refunded since): no second payment may be accepted. */
export const PAID_INTENT_STATUSES: PaymentIntentStatus[] = [P.CAPTURED, P.PARTIALLY_REFUNDED, P.REFUNDED];

export function canIntentTransition(from: PaymentIntentStatus, to: PaymentIntentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function intentAllowedFrom(to: PaymentIntentStatus): PaymentIntentStatus[] {
  return (Object.keys(TRANSITIONS) as PaymentIntentStatus[]).filter((from) => canIntentTransition(from, to));
}

/** The intent status once `refunded` (processed refunds of the accepted capture) has gone back out of `captured`. */
export function statusAfterRefunds(captured: Prisma.Decimal, refunded: Prisma.Decimal): PaymentIntentStatus {
  if (refunded.lte(0)) return P.CAPTURED;
  return refunded.gte(captured) ? P.REFUNDED : P.PARTIALLY_REFUNDED;
}
