import { SmsProvider, SmsReceipt } from './sms-provider.port';

export const HUBTEL_SMS_URL = 'https://smsc.hubtel.com/v1/messages/send';
const DEFAULT_TIMEOUT_MS = 10_000;

export interface HubtelCredentials {
  clientId: string;
  clientSecret: string;
  /** The registered sender id recipients see (at most 11 characters). */
  senderId: string;
}

type Fetch = typeof fetch;

/**
 * Hubtel's SMS API over Node's fetch: POST with Basic auth (client id and secret) and a JSON body of From, To and
 * Content (Basic auth on POST is confirmed by Hubtel's docs). The response schema could not be verified (the docs
 * site was unreachable again in P6-N.2), so it is read defensively: success needs HTTP 2xx, a message id (messageId
 * or MessageId) and, when a status is present, status 0, which is returned as the receipt status. Errors carry the
 * HTTP status and Hubtel's status only, never the phone number, text or credentials.
 */
export class HubtelSmsProvider implements SmsProvider {
  constructor(
    private readonly credentials: HubtelCredentials,
    private readonly fetchFn: Fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async send(to: string, text: string): Promise<SmsReceipt> {
    const { clientId, clientSecret, senderId } = this.credentials;
    let response: Response;
    try {
      response = await this.fetchFn(HUBTEL_SMS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ From: senderId, To: to.replace(/^\+/, ''), Content: text }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      // An abort is a DOMException, which is not always `instanceof Error`; its name (TimeoutError) is what matters.
      const name = (error as { name?: unknown } | null)?.name;
      const reason = typeof name === 'string' ? name : 'unknown error';
      throw new Error(`Hubtel SMS request failed: ${reason}`);
    }
    if (!response.ok) throw new Error(`Hubtel SMS refused: HTTP ${response.status}`);
    return receiptOf(await readJson(response));
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(`Hubtel SMS answered HTTP ${response.status} without a JSON body`);
  }
}

function receiptOf(body: unknown): SmsReceipt {
  if (typeof body !== 'object' || body === null) throw new Error('Hubtel SMS answered with an unexpected body');
  const fields = body as Record<string, unknown>;
  const status = fields.status ?? fields.Status;
  if (status !== undefined && Number(status) !== 0)
    throw new Error(`Hubtel SMS not accepted: status ${String(status)}`);
  const messageId = fields.messageId ?? fields.MessageId;
  if (typeof messageId !== 'string' || messageId === '') throw new Error('Hubtel SMS answered without a message id');
  return status === undefined ? { messageId } : { messageId, status: String(status) };
}
