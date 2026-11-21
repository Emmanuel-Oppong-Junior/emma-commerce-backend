import { Injectable } from '@nestjs/common';
import { PaymentProvider as ProviderName } from '../../generated/prisma/client';
import { PaymentProvider } from './payment-provider.port';
import { PaystackAdapter } from './paystack.adapter';
import { CashOnDeliveryAdapter } from './cash-on-delivery.adapter';

/** The adapter for each provider an attempt or a payment method names. */
@Injectable()
export class PaymentProviderRegistry {
  private readonly providers: ReadonlyMap<ProviderName, PaymentProvider>;

  constructor(paystack: PaystackAdapter, cashOnDelivery: CashOnDeliveryAdapter) {
    this.providers = new Map<ProviderName, PaymentProvider>([
      [paystack.name, paystack],
      [cashOnDelivery.name, cashOnDelivery],
    ]);
  }

  get(name: ProviderName): PaymentProvider {
    const provider = this.providers.get(name);
    if (!provider) throw new Error(`No payment provider adapter for "${name}"`);
    return provider;
  }
}
