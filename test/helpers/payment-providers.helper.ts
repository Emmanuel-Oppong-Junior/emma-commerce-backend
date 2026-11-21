import { PaystackClient } from '../../src/payment/paystack.client';
import { PaystackAdapter } from '../../src/payment/providers/paystack.adapter';
import { CashOnDeliveryAdapter } from '../../src/payment/providers/cash-on-delivery.adapter';
import { PaymentProviderRegistry } from '../../src/payment/providers/payment-provider.registry';

export const TEST_PAYSTACK_SECRET = 'sk_test_webhook_secret';

/** The real adapters and registry over a mocked Paystack HTTP client, so unit tests mock only the I/O boundary. */
export function providerRegistryWith(
  paystack: Partial<Record<keyof PaystackClient, jest.Mock>>,
  settings: { secretKey?: string; callbackUrl?: string } = {},
): PaymentProviderRegistry {
  const values: Record<string, string | undefined> = {
    PAYSTACK_SECRET_KEY: settings.secretKey ?? TEST_PAYSTACK_SECRET,
    PAYSTACK_CALLBACK_URL: settings.callbackUrl,
  };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const value = values[key];
      if (value === undefined) throw new Error(`${key} is not set`);
      return value;
    },
  };
  return new PaymentProviderRegistry(
    new PaystackAdapter(paystack as unknown as PaystackClient, config as never),
    new CashOnDeliveryAdapter(),
  );
}
