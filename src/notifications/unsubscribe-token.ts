import { createHmac, timingSafeEqual } from 'node:crypto';

/** The key that signs unsubscribe links, derived from MFA_ENCRYPTION_KEY with its own label (as delivery codes are). */
export function unsubscribeKey(mfaKey: Buffer): Buffer {
  return createHmac('sha256', mfaKey).update('marketing-unsubscribe').digest();
}

function signature(key: Buffer, userId: string): Buffer {
  return createHmac('sha256', key).update(`unsubscribe:EMAIL:${userId}`).digest();
}

/**
 * A link token that withdraws the user's email marketing consent: the user id and an HMAC of it. It does not expire:
 * an unsubscribe link must keep working, and all it can do is opt the user out.
 */
export function unsubscribeToken(key: Buffer, userId: string): string {
  return `${Buffer.from(userId).toString('base64url')}.${signature(key, userId).toString('base64url')}`;
}

/** The user id the token was issued for, or null when it is malformed or its signature does not match. */
export function verifyUnsubscribeToken(key: Buffer, token: string): string | null {
  const [encodedUser, encodedSignature, ...rest] = token.split('.');
  if (!encodedUser || !encodedSignature || rest.length > 0) return null;
  const userId = Buffer.from(encodedUser, 'base64url').toString('utf8');
  const given = Buffer.from(encodedSignature, 'base64url');
  const expected = signature(key, userId);
  return given.length === expected.length && timingSafeEqual(given, expected) ? userId : null;
}
