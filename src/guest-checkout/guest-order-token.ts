import { createHmac, timingSafeEqual } from 'node:crypto';

const ORDER_ID_SHAPE = /^[A-Za-z0-9]{1,64}$/;

/**
 * The key guest order tokens are signed with, derived from MFA_ENCRYPTION_KEY with its own label (as the phone code
 * and delivery code keys are), so no new secret is needed and a token cannot be forged without the server secret.
 */
export function guestOrderTokenKey(mfaKey: Buffer): Buffer {
  return createHmac('sha256', mfaKey).update('guest-order-access').digest();
}

function signature(key: Buffer, orderId: string): Buffer {
  return createHmac('sha256', key).update(`guest-order:${orderId}`).digest();
}

/**
 * The guest's access token for one order: the order id and its HMAC. It cannot be guessed or derived for another
 * order, and the worker can recompute it for the order's SMS and email link, so it is never stored.
 */
export function guestOrderToken(key: Buffer, orderId: string): string {
  return `${orderId}.${signature(key, orderId).toString('base64url')}`;
}

/** The order a token was issued for, or null when it is malformed or its signature does not match. */
export function orderIdFromGuestToken(key: Buffer, token: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const orderId = token.slice(0, dot);
  if (!ORDER_ID_SHAPE.test(orderId)) return null;
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = signature(key, orderId);
  return given.length === expected.length && timingSafeEqual(given, expected) ? orderId : null;
}

/** The storefront page for a guest order; the token goes in the fragment, which browsers never send on. */
export function guestOrderUrl(frontendUrl: string, token: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}/guest-order#token=${encodeURIComponent(token)}`;
}
