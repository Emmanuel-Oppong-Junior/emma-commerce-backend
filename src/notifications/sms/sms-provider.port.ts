export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsReceipt {
  messageId: string;
  status?: string;
}

/** An SMS gateway (ADR-0015: channels behind ports). Throws when the message was not accepted, so the job retries. */
export interface SmsProvider {
  /** Sends `text` to `to` (E.164) and returns the provider's message id and its status code, when it gives one. */
  send(to: string, text: string): Promise<SmsReceipt>;
}

/** The last 3 digits only, for logs: `***456`. */
export function maskPhone(phone: string): string {
  return `***${phone.replace(/\D/g, '').slice(-3)}`;
}
