import { BadRequestException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import {
  openProviderSecret,
  parsePaymentConfigKey,
  providerSecretContext,
  sealProviderSecret,
} from './provider-secret-crypto';
import { assertPublicKeyMatches, envPaystackModeOf, lastFour, paystackModeOf } from './paystack-keys';
import {
  assertOrderPaymentMethodAvailable,
  availablePaymentMethods,
  OnlinePaymentMethod,
  onlineProviderFor,
  PAYMENT_METHOD_UNAVAILABLE,
  PaymentMethodSettings,
} from './payment-methods';

const SECRET = 'sk_live_4f9a8b7c6d5e4f3a2b1c';

describe('provider secret encryption', () => {
  const key = randomBytes(32);
  const context = providerSecretContext('store1', 'PAYSTACK');

  it('round-trips a secret', () => {
    expect(openProviderSecret(key, sealProviderSecret(key, SECRET, context), context)).toBe(SECRET);
  });

  it('never stores the plaintext and uses a fresh IV each time', () => {
    const first = sealProviderSecret(key, SECRET, context);
    const second = sealProviderSecret(key, SECRET, context);

    expect(first).not.toContain(SECRET);
    expect(first).not.toContain(Buffer.from(SECRET).toString('base64url'));
    expect(first).not.toBe(second);
  });

  it('fails with another key', () => {
    const sealed = sealProviderSecret(key, SECRET, context);
    expect(() => openProviderSecret(randomBytes(32), sealed, context)).toThrow();
  });

  it.each([
    ['another store', providerSecretContext('store2', 'PAYSTACK')],
    ['another provider', providerSecretContext('store1', 'FLUTTERWAVE')],
  ])('fails when the ciphertext is moved to %s', (_label, otherContext) => {
    const sealed = sealProviderSecret(key, SECRET, context);
    expect(() => openProviderSecret(key, sealed, otherContext)).toThrow();
  });

  it('fails on a tampered ciphertext', () => {
    const [version, iv, tag, ciphertext] = sealProviderSecret(key, SECRET, context).split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 1;
    expect(() =>
      openProviderSecret(key, [version, iv, tag, flipped.toString('base64url')].join('.'), context),
    ).toThrow();
  });

  it('refuses a key that is not 32 bytes of hex', () => {
    expect(() => parsePaymentConfigKey('abc')).toThrow('PAYMENT_CONFIG_ENCRYPTION_KEY must be 64 hexadecimal');
  });
});

describe('Paystack keys', () => {
  it.each([
    ['sk_test_abc123', 'TEST'],
    ['sk_live_abc123', 'LIVE'],
  ])('derives the mode of %s', (secretKey, mode) => {
    expect(paystackModeOf(secretKey)).toBe(mode);
  });

  it.each(['pk_live_abc', 'sk_prod_abc', 'abc', 'sk_live_'])('refuses %s as a secret key', (secretKey) => {
    expect(() => paystackModeOf(secretKey)).toThrow(BadRequestException);
  });

  it('accepts a public key of the same mode and refuses a mismatch', () => {
    expect(() => assertPublicKeyMatches('pk_live_x1', 'LIVE')).not.toThrow();
    expect(() => assertPublicKeyMatches('pk_test_x1', 'LIVE')).toThrow(
      'publicKey is a TEST key but secretKey is a LIVE key',
    );
    expect(() => assertPublicKeyMatches('sk_live_x1', 'LIVE')).toThrow(BadRequestException);
  });

  it('leaves the mode of an unprefixed environment key unknown', () => {
    expect(envPaystackModeOf('ci-smoke')).toBeNull();
    expect(envPaystackModeOf('sk_test_e2e')).toBe('TEST');
  });

  it('shows only the last 4 characters', () => {
    expect(lastFour(SECRET)).toBe('2b1c');
  });
});

describe('payment methods', () => {
  const allOn: PaymentMethodSettings = {
    cardPaymentsEnabled: true,
    mobileMoneyPaymentsEnabled: true,
    cashOnDeliveryEnabled: true,
    cardPaymentProvider: 'PAYSTACK',
    mobileMoneyPaymentProvider: 'PAYSTACK',
  };
  const paystack = new Set(['PAYSTACK' as const]);
  const reasonOf = (call: () => unknown) => {
    try {
      call();
    } catch (error) {
      return ((error as BadRequestException).getResponse() as { extensions?: { reason?: string } }).extensions?.reason;
    }
    return undefined;
  };

  it('offers every method by default when Paystack is configured', () => {
    expect(availablePaymentMethods(allOn, paystack)).toEqual({
      online: [
        { method: OnlinePaymentMethod.CARD, provider: 'PAYSTACK' },
        { method: OnlinePaymentMethod.MOBILE_MONEY, provider: 'PAYSTACK' },
      ],
      cashOnDelivery: true,
    });
  });

  it('offers no online method while its provider has no credentials', () => {
    expect(availablePaymentMethods(allOn, new Set()).online).toEqual([]);
  });

  it('drops a switched-off method', () => {
    const available = availablePaymentMethods({ ...allOn, cardPaymentsEnabled: false }, paystack);
    expect(available.online.map((option) => option.method)).toEqual([OnlinePaymentMethod.MOBILE_MONEY]);
    expect(reasonOf(() => onlineProviderFor(available, OnlinePaymentMethod.CARD))).toBe(PAYMENT_METHOD_UNAVAILABLE);
    expect(onlineProviderFor(available, OnlinePaymentMethod.MOBILE_MONEY)).toBe('PAYSTACK');
  });

  it('refuses an ONLINE order with no online method, and a COD order with COD off, as BAD_REQUEST', () => {
    const noOnline = availablePaymentMethods(allOn, new Set());
    const noCod = availablePaymentMethods({ ...allOn, cashOnDeliveryEnabled: false }, paystack);

    expect(() => assertOrderPaymentMethodAvailable(noOnline, 'ONLINE')).toThrow(BadRequestException);
    expect(reasonOf(() => assertOrderPaymentMethodAvailable(noCod, 'CASH_ON_DELIVERY'))).toBe(
      PAYMENT_METHOD_UNAVAILABLE,
    );
    expect(() => assertOrderPaymentMethodAvailable(noOnline, 'CASH_ON_DELIVERY')).not.toThrow();
    expect(() => assertOrderPaymentMethodAvailable(noCod, 'ONLINE')).not.toThrow();
  });
});
