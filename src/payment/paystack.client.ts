import { BadGatewayException, GatewayTimeoutException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PAYSTACK_TRANSACTION_INI_URL,
  PAYSTACK_TRANSACTION_LIST_URL,
  PAYSTACK_TRANSACTION_VERIFY_BASE_URL,
} from './constant';

export const PAYSTACK_TIMEOUT_MS = 8000;

export interface InitializeTransactionRequest {
  email: string;
  /** In subunits (pesewas). */
  amount: number;
  currency: string;
  reference: string;
  callback_url?: string;
}

export interface InitializedTransaction {
  authorization_url: string;
  access_code: string | null;
  reference: string | null;
}

/** Paystack's transaction as returned by verify. Fields are checked by `parseProviderVerification`. */
export interface VerifiedTransaction {
  reference?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  channel?: unknown;
  paid_at?: unknown;
  gateway_response?: unknown;
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

/**
 * The Paystack calls the app makes, over `fetch` with a timeout. Transport failures, timeouts, non-2xx answers and
 * malformed envelopes all surface as 502/504 so callers never act on a response they could not read.
 */
@Injectable()
export class PaystackClient {
  private readonly secretKey: string;

  constructor(configService: ConfigService) {
    this.secretKey = configService.getOrThrow<string>('PAYSTACK_SECRET_KEY');
  }

  async initializeTransaction(request: InitializeTransactionRequest): Promise<InitializedTransaction> {
    const data = await this.call('initialize', PAYSTACK_TRANSACTION_INI_URL, {
      method: 'POST',
      body: JSON.stringify(request),
    });
    if (typeof data.authorization_url !== 'string' || data.authorization_url === '') {
      throw new BadGatewayException('Paystack initialize returned no authorization_url');
    }
    return {
      authorization_url: data.authorization_url,
      access_code: typeof data.access_code === 'string' ? data.access_code : null,
      reference: typeof data.reference === 'string' ? data.reference : null,
    };
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    return this.call('verify', `${PAYSTACK_TRANSACTION_VERIFY_BASE_URL}/${encodeURIComponent(reference)}`, {
      method: 'GET',
    });
  }

  /** One page of `GET /transaction`, filtered by creation time and status. Customer and card fields are dropped. */
  async listTransactions(request: ListTransactionsRequest): Promise<TransactionPage> {
    const query = new URLSearchParams({
      from: request.from.toISOString(),
      to: request.to.toISOString(),
      status: request.status,
      perPage: String(request.perPage),
      page: String(request.page),
    });
    const envelope = await this.send('list', `${PAYSTACK_TRANSACTION_LIST_URL}?${query.toString()}`, { method: 'GET' });
    const pageCount = isRecord(envelope.meta) ? envelope.meta.pageCount : undefined;
    if (!Array.isArray(envelope.data) || !Number.isSafeInteger(pageCount)) {
      throw new BadGatewayException('Paystack list returned no data array or page count');
    }
    return { transactions: envelope.data.map(toListedTransaction), pageCount: pageCount as number };
  }

  private async call(operation: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const envelope = await this.send(operation, url, init);
    if (!isRecord(envelope.data)) {
      throw new BadGatewayException(`Paystack ${operation} returned no data object`);
    }
    return envelope.data;
  }

  private async send(operation: string, url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    let body: unknown;
    try {
      response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(PAYSTACK_TIMEOUT_MS),
      });
      body = await response.text().then(parseJson);
    } catch (error) {
      // fetch rejects with a DOMException, which is not an `instanceof Error` in every realm, so match on its name.
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GatewayTimeoutException(`Paystack ${operation} did not answer within ${PAYSTACK_TIMEOUT_MS} ms`);
      }
      throw new BadGatewayException(
        `Paystack ${operation} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const envelope = isRecord(body) ? body : {};
    if (!response.ok || envelope.status !== true) {
      const message = typeof envelope.message === 'string' ? `: ${envelope.message.slice(0, 200)}` : '';
      throw new BadGatewayException(`Paystack ${operation} failed with HTTP ${response.status}${message}`);
    }
    return envelope;
  }
}

function toListedTransaction(item: unknown): ListedTransaction {
  if (
    !isRecord(item) ||
    typeof item.reference !== 'string' ||
    typeof item.status !== 'string' ||
    !Number.isSafeInteger(item.amount) ||
    typeof item.currency !== 'string'
  ) {
    throw new BadGatewayException('Paystack list returned a transaction without reference, status, amount or currency');
  }
  return { reference: item.reference, status: item.status, amount: item.amount as number, currency: item.currency };
}

// An error page from a proxy is not JSON; it is reported through the HTTP status instead.
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
