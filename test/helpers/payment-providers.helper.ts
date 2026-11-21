import { PaystackClient } from '../../src/payment/paystack.client';
import { PaystackAdapter } from '../../src/payment/providers/paystack.adapter';
import { CashOnDeliveryAdapter } from '../../src/payment/providers/cash-on-delivery.adapter';
import { PaymentProviderRegistry } from '../../src/payment/providers/payment-provider.registry';

export const TEST_PAYSTACK_SECRET = 'sk_test_webhook_secret';

/**
 * PaymentSettingsService as the payment code sees it, for unit tests: Paystack configured with `secretKey`, every
 * method on offer and served by Paystack. Override a function to test refusals.
 */
export function paymentSettingsStub(settings: { secretKey?: string; callbackUrl?: string } = {}) {
  const credentials = { secretKey: settings.secretKey ?? TEST_PAYSTACK_SECRET, callbackUrl: settings.callbackUrl };
  return {
    paystackCredentials: jest.fn(async () => credentials),
    requirePaystackCredentials: jest.fn(async () => credentials),
    onlineProviderFor: jest.fn(async () => 'PAYSTACK'),
    assertOrderPaymentMethod: jest.fn(async () => undefined),
  };
}

/** The real adapters and registry over a mocked Paystack HTTP client, so unit tests mock only the I/O boundary. */
export function providerRegistryWith(
  paystack: Partial<Record<keyof PaystackClient, jest.Mock>>,
  settings: ReturnType<typeof paymentSettingsStub> | { secretKey?: string; callbackUrl?: string } = {},
): PaymentProviderRegistry {
  const stub = 'paystackCredentials' in settings ? settings : paymentSettingsStub(settings);
  return new PaymentProviderRegistry(
    new PaystackAdapter(paystack as unknown as PaystackClient, stub as never),
    new CashOnDeliveryAdapter(),
  );
}
