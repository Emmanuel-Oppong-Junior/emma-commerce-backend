import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider as ProviderName, Prisma } from '../../generated/prisma/client';
import { toMinorUnits } from '../../commons/money/money';
import { PAYSTACK_WEBHOOK_SIGNATURE_KEY } from '../constant';
import { PaystackClient, VerifiedTransaction } from '../paystack.client';
import { isSettlingEvent, isValidPaystackSignature, parsePaystackWebhook } from '../paystack-webhook';
import { parseProviderVerification } from '../payment-verification';
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

@Injectable()
export class PaystackAdapter implements PaymentProvider {
  readonly name = ProviderName.PAYSTACK;
  readonly label = 'Paystack';
  readonly capabilities = { onlineCheckout: true, refunds: true, webhooks: true, transactionList: true };

  constructor(
    private readonly client: PaystackClient,
    private readonly configService: ConfigService,
  ) {}

  async initialize(request: CheckoutRequest): Promise<OpenedCheckout> {
    const transaction = await this.client.initializeTransaction({
      email: request.email,
      amount: toMinorUnits(request.amount),
      currency: request.currency,
      reference: request.reference,
      callback_url: this.configService.get('PAYSTACK_CALLBACK_URL'),
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
    const secret = this.configService.getOrThrow<string>('PAYSTACK_SECRET_KEY');
    if (!isValidPaystackSignature(rawBody, typeof signature === 'string' ? signature : undefined, secret)) {
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
