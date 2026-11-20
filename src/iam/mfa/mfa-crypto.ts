import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { base32Encode } from './totp';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/** MFA_ENCRYPTION_KEY: 32 bytes as 64 hex characters (env validation enforces the format). */
export function parseMfaKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('MFA_ENCRYPTION_KEY must be 64 hexadecimal characters');
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a TOTP secret with AES-256-GCM. `context` (the user id) is bound as additional data, so a ciphertext
 * copied onto another user's row does not decrypt.
 */
export function sealSecret(
  key: Buffer,
  plaintext: string,
  context: string,
  iv: Buffer = randomBytes(IV_BYTES),
): string {
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))].join('.');
}

/** Decrypts a sealed secret; throws if it was altered, belongs to another context or was sealed with another key. */
export function openSecret(key: Buffer, sealed: string, context: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported or malformed encrypted MFA secret');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Keyed hash of a recovery code. Recovery codes carry about 50 bits of entropy, so a plain hash could be brute-forced
 * from a database dump; keying it with a key derived from MFA_ENCRYPTION_KEY prevents that.
 */
export function hashRecoveryCode(key: Buffer, userId: string, code: string): string {
  const hashKey = createHmac('sha256', key).update('mfa-recovery-code').digest();
  return createHmac('sha256', hashKey)
    .update(`${userId}:${normalizeRecoveryCode(code)}`)
    .digest('hex');
}

export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

export const RECOVERY_CODE_COUNT = 10;

/** Single-use recovery codes like "k3m9q-xw2pa": 10 base32 characters (50 bits) each. Shown once, stored hashed. */
export function generateRecoveryCodes(random: (bytes: number) => Buffer = randomBytes): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const chars = base32Encode(random(7)).slice(0, 10).toLowerCase();
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}
