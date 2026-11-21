import { BadGatewayException, UnauthorizedException } from '@nestjs/common';
import { PaymentProvider as ProviderName, Prisma } from '../../generated/prisma/client';
import { ProviderVerification } from '../payment-verification';

/** What a provider can do; callers check it before asking for an operation (ADR-0007 §1). */
export interface ProviderCapabilities {
  /** Opens a hosted checkout the customer pays at. */
  onlineCheckout: boolean;
  refunds: boolean;
  webhooks: boolean;
  /** Lists its transactions, for the nightly reconciliation diff. */
  transactionList: boolean;
}

export interface CheckoutRequest {
  email: string;
  amount: Prisma.Decimal;
  currency: string;
  reference: string;
}

export interface OpenedCheckout {
  authorizationUrl: string;
  /** Sanitised provider data kept on the attempt for audit. */
  details: Prisma.InputJsonValue;
}

export interface Verification {
  verification: ProviderVerification;
  /** Sanitised provider data kept on the attempt for audit. */
  details: Prisma.InputJsonValue;
}

export interface RefundRequest {
  reference: string;
  amount: Prisma.Decimal;
}

export interface ListTransactionsRequest {
  from: Date;
  to: Date;
  status: 'success' | 'failed' | 'abandoned';
  page: number;
  perPage: number;
}

/** One listed transaction, reduced to what reconciliation compares. `amount` is in subunits (pesewas). */
export interface ListedTransaction {
  reference: string;
  status: string;
  amount: number;
  currency: string;
}

export interface TransactionPage {
  transactions: ListedTransaction[];
  pageCount: number;
}

/** A webhook whose signature checked out, reduced to what the inbox stores and the processor needs. */
export interface VerifiedEvent {
  event: string;
  eventKey: string;
  reference: string | null;
  payload: Prisma.InputJsonValue;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

/**
 * The provider answered with a refusal and did nothing (for Paystack: a 4xx with `status: false`). Every other
 * failure leaves the outcome unknown.
 */
export class ProviderRequestRejected extends BadGatewayException {}

/** The webhook signature did not check out against the provider secret, or there is no secret to check it with. */
export class WebhookSignatureRejected extends UnauthorizedException {}

/** The port every payment provider implements (ADR-0007 §1). Callers reach providers only through it. */
export interface PaymentProvider {
  readonly name: ProviderName;
  /** For messages and logs, e.g. "Paystack". */
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  initialize(request: CheckoutRequest): Promise<OpenedCheckout>;
  verify(reference: string): Promise<Verification>;
  /** Returns the provider's refund id. Throws ProviderRequestRejected when the provider refused it. */
  refund(request: RefundRequest): Promise<string>;
  /** Checks the signature over the raw body and parses the event. Throws WebhookSignatureRejected on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: WebhookHeaders): Promise<VerifiedEvent>;
  /** Whether a stored event of this type settles a payment attempt by re-verifying its reference. */
  settlesPayment(event: string): boolean;
  listTransactions(request: ListTransactionsRequest): Promise<TransactionPage>;
}
