import { createHmac, timingSafeEqual } from 'node:crypto';

// RFC 6238 TOTP with the parameters every authenticator app defaults to: HMAC-SHA1, 6 digits, 30-second steps.
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
// Codes from one step before or after the current one are accepted, for clock drift and typing time.
const TOTP_WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4226 HOTP: the code for one counter value. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totp(secret: Buffer, nowMs: number, digits = TOTP_DIGITS): string {
  return hotp(secret, timeStep(nowMs), digits);
}

/**
 * The time step whose code equals `code`, within one step of now, or null. Steps at or before `lastUsedStep` never
 * match, so a code that was already accepted cannot be replayed.
 */
export function matchTotp(secret: Buffer, code: string, nowMs: number, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = timeStep(nowMs);
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

/** RFC 4648 base32 without padding, the secret format of otpauth:// URIs. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** The otpauth:// URI an authenticator app scans (the frontend draws it as a QR code). */
export function otpauthUri(issuer: string, accountName: string, base32Secret: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  // Percent-encoded rather than URLSearchParams, whose "+" for a space some authenticator apps show literally.
  const params = Object.entries({
    secret: base32Secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  }).map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  return `otpauth://totp/${label}?${params.join('&')}`;
}
