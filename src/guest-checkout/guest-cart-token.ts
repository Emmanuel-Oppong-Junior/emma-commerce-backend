import { createHash, randomBytes } from 'node:crypto';

/** A guest cart lives this long after its last use (each guest cart operation extends it). */
export const GUEST_CART_IDLE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'gct_';
const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^gct_[A-Za-z0-9_-]{43}$/;

/** A new guest cart token: 256 random bits. Only its hash is stored, so a database read cannot replay it. */
export function newGuestCartToken(random: (size: number) => Buffer = randomBytes): string {
  return `${TOKEN_PREFIX}${random(TOKEN_BYTES).toString('base64url')}`;
}

/** What the cart row stores and is looked up by; null for a value that cannot be a token. */
export function guestCartTokenHash(token: string): string | null {
  return TOKEN_SHAPE.test(token) ? createHash('sha256').update(token).digest('hex') : null;
}

export function guestCartExpiry(now: Date): Date {
  return new Date(now.getTime() + GUEST_CART_IDLE_DAYS * DAY_MS);
}

/** The subject a guest's phone code is bound to (PhoneOtpStore), never equal to an account id. */
export function guestOtpSubject(cartId: string): string {
  return `guest:${cartId}`;
}
