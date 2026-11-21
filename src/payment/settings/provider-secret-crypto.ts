import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/** PAYMENT_CONFIG_ENCRYPTION_KEY: 32 bytes as 64 hex characters (env validation enforces the format). */
export function parsePaymentConfigKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('PAYMENT_CONFIG_ENCRYPTION_KEY must be 64 hexadecimal characters');
  }
  return Buffer.from(hex, 'hex');
}

/** The additional data a provider secret is bound to, so a ciphertext copied to another store or provider fails. */
export function providerSecretContext(storeId: string, provider: string): string {
  return `${storeId}:${provider}`;
}

/** Encrypts a provider secret with AES-256-GCM under a random IV, binding `context` as additional data. */
export function sealProviderSecret(key: Buffer, plaintext: string, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [VERSION, ...[iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url'))].join('.');
}

/** Decrypts a sealed provider secret; throws if it was altered, belongs to another context or another key. */
export function openProviderSecret(key: Buffer, sealed: string, context: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error('Unsupported or malformed encrypted payment provider secret');
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
}
