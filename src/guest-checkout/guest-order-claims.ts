/** A guest checkout's phone verification counts for a sign-up for this long (a recycled number must not carry over). */
export const GUEST_PHONE_CLAIM_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `extensions.reason` when staff act on a guest order for something only an account has (a return). */
export const GUEST_ORDER_NOT_ATTACHED = 'GUEST_ORDER_NOT_ATTACHED';

/** `extensions.reason` of a sign-up refused for its guest order token. */
export enum GuestClaimRefusal {
  /** The token is not a guest order's (or is malformed). */
  INVALID_GUEST_ORDER_TOKEN = 'INVALID_GUEST_ORDER_TOKEN',
  /** The guest checkout's phone verification is older than GUEST_PHONE_CLAIM_DAYS: verify the phone again. */
  GUEST_VERIFICATION_EXPIRED = 'GUEST_VERIFICATION_EXPIRED',
  /** Another account holds the phone number. */
  PHONE_IN_USE = 'PHONE_IN_USE',
}

export interface GuestOrderOwner {
  userId: string | null;
  guestPhone: string | null;
}

/**
 * Whether an account whose verified phone is `verifiedPhone` takes over a guest order: only an order no account holds
 * yet, placed with exactly that verified phone. Never by email, and never across a different phone.
 */
export function claimsGuestOrder(order: GuestOrderOwner, verifiedPhone: string | null): boolean {
  return order.userId === null && verifiedPhone !== null && order.guestPhone === verifiedPhone;
}

/**
 * A sign-up that brings a guest order token: the guest's verified phone becomes the new account's verified phone (so
 * its guest orders attach) when the verification is recent and no other account holds the number.
 */
export function signUpPhoneClaim(
  order: { guestPhone: string | null; guestPhoneVerifiedAt: Date | null } | null,
  phoneHeldByAnotherAccount: boolean,
  now: Date,
): { phone: string; verifiedAt: Date } | { refused: GuestClaimRefusal } {
  if (!order?.guestPhone || !order.guestPhoneVerifiedAt)
    return { refused: GuestClaimRefusal.INVALID_GUEST_ORDER_TOKEN };
  if (now.getTime() - order.guestPhoneVerifiedAt.getTime() > GUEST_PHONE_CLAIM_DAYS * DAY_MS) {
    return { refused: GuestClaimRefusal.GUEST_VERIFICATION_EXPIRED };
  }
  if (phoneHeldByAnotherAccount) return { refused: GuestClaimRefusal.PHONE_IN_USE };
  return { phone: order.guestPhone, verifiedAt: order.guestPhoneVerifiedAt };
}
