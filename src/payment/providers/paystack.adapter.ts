import { Injectable } from '@nestjs/common';
import { PaymentProvider as ProviderName, Prisma } from '../../generated/prisma/client';
import { toMinorUnits } from '../../commons/money/money';
import { PAYSTACK_WEBHOOK_SIGNATURE_KEY } from '../constant';
import { PaystackClient, VerifiedTransaction } from '../paystack.client';
import { isSettlingEvent, isValidPaystackSignature, parsePaystackWebhook } from '../paystack-webhook';
import { parseProviderVerification } from '../payment-verification';
import { PaymentSettingsService } from '../settings/payment-settings.service';
import { OnlinePaymentMethod } from '../settings/payment-methods';
import {
  CheckoutRequest,
  ListTransactionsRequest,
  OpenedCheckout,
  PaymentProvider,
  RefundRequest,
  TransactionPage,
  Verification,
  VerifiedEvent,
  WebhookHeaders,
  WebhookSignatureRejected,
} from './payment-provider.port';

const CHANNELS: Record<OnlinePaymentMethod, string[]> = {
  [OnlinePaymentMethod.CARD]: ['card'],
  [OnlinePaymentMethod.MOBILE_MONEY]: ['mobile_money'],
};

@Injectable()
export class PaystackAdapter implements PaymentProvider {
  readonly name = ProviderName.PAYSTACK;
  readonly label = 'Paystack';
  readonly capabilities = { onlineCheckout: true, refunds: true, webhooks: true, transactionList: true };

  constructor(
    private readonly client: PaystackClient,
    private readonly paymentSettings: PaymentSettingsService,
  ) {}

  async initialize(request: CheckoutRequest): Promise<OpenedCheckout> {
    const { callbackUrl } = await this.paymentSettings.requirePaystackCredentials();
    const transaction = await this.client.initializeTransaction({
      email: request.email,
      amount: toMinorUnits(request.amount),
      currency: request.currency,
      reference: request.reference,
      callback_url: callbackUrl,
      channels: CHANNELS[request.method],
    });
    // The checkout URL is kept in its own column so an idempotent retry can hand it back.
    const details = { reference: transaction.reference ?? null, access_code: transaction.access_code ?? null };
    return { authorizationUrl: transaction.authorization_url, details };
  }

  async verify(reference: string): Promise<Verification> {
    const transaction = await this.client.verifyTransaction(reference);
    return { verification: parseProviderVerification(reference, transaction), details: verifyDetails(transaction) };
  }

  async refund(request: RefundRequest): Promise<string> {
    const { id } = await this.client.createRefund({
      transaction: request.reference,
      amount: toMinorUnits(request.amount),
    });
    return id;
  }

  async parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<VerifiedEvent> {
    const signature = headers[PAYSTACK_WEBHOOK_SIGNATURE_KEY];
    const credentials = await this.paymentSettings.paystackCredentials();
    if (!credentials) {
      throw new WebhookSignatureRejected('Paystack is not configured, so the webhook signature cannot be checked');
    }
    const valid = isValidPaystackSignature(
      rawBody,
      typeof signature === 'string' ? signature : undefined,
      credentials.secretKey,
    );
    if (!valid) {
      throw new WebhookSignatureRejected('Invalid webhook signature');
    }
    return parsePaystackWebhook(rawBody);
  }

  settlesPayment(event: string): boolean {
    return isSettlingEvent(event);
  }

  listTransactions(request: ListTransactionsRequest): Promise<TransactionPage> {
    return this.client.listTransactions(request);
  }
}

/** Verification data reduced to safe audit fields: no customer PII, IP addresses, channel tokens or authorizations. */
function verifyDetails(data: VerifiedTransaction): Prisma.InputJsonValue {
  return {
    reference: data.reference ?? null,
    status: data.status ?? null,
    amount: data.amount ?? null,
    currency: data.currency ?? null,
    channel: data.channel ?? null,
    paid_at: data.paid_at ?? null,
    gateway_response: data.gateway_response ?? null,
  } as Prisma.InputJsonValue;
}
