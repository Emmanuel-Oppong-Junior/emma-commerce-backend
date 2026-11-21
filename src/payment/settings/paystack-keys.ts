import { BadRequestException } from '@nestjs/common';
import { PaymentProviderMode } from '../../generated/prisma/client';

const SECRET_KEY = /^sk_(test|live)_[A-Za-z0-9]+$/;
const PUBLIC_KEY = /^pk_(test|live)_[A-Za-z0-9]+$/;

/** Test or live, from the key's prefix; null for a key without a recognised prefix. */
function modeOf(key: string, pattern: RegExp): PaymentProviderMode | null {
  const match = pattern.exec(key);
  if (!match) return null;
  return match[1] === 'live' ? PaymentProviderMode.LIVE : PaymentProviderMode.TEST;
}

/** The mode of a Paystack secret key typed by staff; refuses anything but an sk_test_/sk_live_ key. */
export function paystackModeOf(secretKey: string): PaymentProviderMode {
  const mode = modeOf(secretKey, SECRET_KEY);
  if (!mode)
    throw new BadRequestException('secretKey must be a Paystack secret key starting with sk_test_ or sk_live_');
  return mode;
}

/** A PAYSTACK_SECRET_KEY from the environment is not checked at startup, so its mode may be unknown. */
export function envPaystackModeOf(secretKey: string): PaymentProviderMode | null {
  return modeOf(secretKey, SECRET_KEY);
}

/** The public key must be a Paystack public key of the same mode as the secret key. */
export function assertPublicKeyMatches(publicKey: string, mode: PaymentProviderMode): void {
  const publicMode = modeOf(publicKey, PUBLIC_KEY);
  if (!publicMode)
    throw new BadRequestException('publicKey must be a Paystack public key starting with pk_test_ or pk_live_');
  if (publicMode !== mode) {
    throw new BadRequestException(
      `publicKey is a ${publicMode} key but secretKey is a ${mode} key; use the keys of one Paystack mode`,
    );
  }
}

/** All a read ever shows of a secret. */
export function lastFour(secret: string): string {
  return secret.slice(-4);
}
