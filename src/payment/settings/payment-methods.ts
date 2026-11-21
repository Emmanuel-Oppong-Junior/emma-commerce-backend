import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, PaymentProvider as ProviderName } from '../../generated/prisma/client';

/** How an online payment is made; chosen per attempt at initiatePayment and served by the provider configured for it. */
export enum OnlinePaymentMethod {
  CARD = 'CARD',
  MOBILE_MONEY = 'MOBILE_MONEY',
}

/** `extensions.reason` of the BAD_REQUEST a checkout or payment fails with when its method is not offered. */
export const PAYMENT_METHOD_UNAVAILABLE = 'PAYMENT_METHOD_UNAVAILABLE';

/** The store's payment-method switches (columns on Store). */
export interface PaymentMethodSettings {
  cardPaymentsEnabled: boolean;
  mobileMoneyPaymentsEnabled: boolean;
  cashOnDeliveryEnabled: boolean;
  cardPaymentProvider: ProviderName;
  mobileMoneyPaymentProvider: ProviderName;
}

export interface AvailableOnlineMethod {
  method: OnlinePaymentMethod;
  provider: ProviderName;
}

export interface AvailablePaymentMethods {
  online: AvailableOnlineMethod[];
  cashOnDelivery: boolean;
}

const METHOD_LABELS: Record<OnlinePaymentMethod, string> = {
  [OnlinePaymentMethod.CARD]: 'Card',
  [OnlinePaymentMethod.MOBILE_MONEY]: 'Mobile money',
};

/** An online method is offered when it is switched on and its provider has credentials (`configured`). */
export function availablePaymentMethods(
  settings: PaymentMethodSettings,
  configured: ReadonlySet<ProviderName>,
): AvailablePaymentMethods {
  const online = [
    { method: OnlinePaymentMethod.CARD, enabled: settings.cardPaymentsEnabled, provider: settings.cardPaymentProvider },
    {
      method: OnlinePaymentMethod.MOBILE_MONEY,
      enabled: settings.mobileMoneyPaymentsEnabled,
      provider: settings.mobileMoneyPaymentProvider,
    },
  ]
    .filter(({ enabled, provider }) => enabled && configured.has(provider))
    .map(({ method, provider }) => ({ method, provider }));
  return { online, cashOnDelivery: settings.cashOnDeliveryEnabled };
}

/** checkoutQuote and createOrder: ONLINE needs at least one online method on offer, CASH_ON_DELIVERY needs COD on. */
export function assertOrderPaymentMethodAvailable(available: AvailablePaymentMethods, method: PaymentMethod): void {
  if (method === PaymentMethod.CASH_ON_DELIVERY) {
    if (!available.cashOnDelivery) throw unavailable('Cash on delivery is not available at this store');
    return;
  }
  if (available.online.length === 0) throw unavailable('Online payment is not available at this store');
}

/** initiatePayment: the provider serving `method`, or BAD_REQUEST when the method is not on offer. */
export function onlineProviderFor(available: AvailablePaymentMethods, method: OnlinePaymentMethod): ProviderName {
  const option = available.online.find((candidate) => candidate.method === method);
  if (!option) throw unavailable(`${METHOD_LABELS[method]} payment is not available at this store`);
  return option.provider;
}

function unavailable(message: string): BadRequestException {
  return new BadRequestException({ message, extensions: { reason: PAYMENT_METHOD_UNAVAILABLE } });
}
