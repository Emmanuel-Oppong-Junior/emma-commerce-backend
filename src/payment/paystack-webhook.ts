import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PAYSTACK_WEBHOOK_CRYPTO_ALGO } from './constant';
import { PaystackEvent } from './enums/paystack-event.enum';
import { isPaystackDisputeEvent, parsePaystackDispute } from './paystack-dispute';

/** A webhook whose signature checked out, reduced to what the inbox stores and the processor needs. */
export interface PaystackWebhookEvent {
  event: string;
  eventKey: string;
  reference: string | null;
  payload: Prisma.InputJsonValue;
}

/** Fields of `data` that carry customer PII or card tokens; they are not needed to settle and are not stored. */
const UNSTORED_DATA_FIELDS = ['customer', 'authorization', 'ip_address', 'log', 'metadata'];

const SETTLING_EVENTS: string[] = [PaystackEvent.CHARGE_SUCCESS, PaystackEvent.CHARGE_FAILED];

/**
 * Paystack signs the exact request bytes: `x-paystack-signature` is the hex HMAC-SHA512 of the raw body keyed with
 * the secret key. Re-serialising parsed JSON changes the bytes, so only the raw body can be checked.
 */
export function isValidPaystackSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac(PAYSTACK_WEBHOOK_CRYPTO_ALGO, secret).update(rawBody).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Parses a signed webhook body. Call only after the signature has been verified. */
export function parsePaystackWebhook(rawBody: Buffer): PaystackWebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new BadRequestException('Webhook body is not valid JSON');
  }
  if (!isRecord(body) || typeof body.event !== 'string' || body.event === '' || !isRecord(body.data)) {
    throw new BadRequestException('Webhook body must have an "event" string and a "data" object');
  }

  const { event, data } = body;
  if (isPaystackDisputeEvent(event)) {
    // Only the validated, provider-neutral notice is stored: the raw dispute carries the customer and card details.
    const dispute = parsePaystackDispute(event, data);
    return {
      event,
      eventKey: disputeEventKey(event, dispute.providerDisputeId, data.updatedAt, rawBody),
      reference: dispute.reference,
      payload: { event, dispute } as unknown as Prisma.InputJsonValue,
    };
  }
  const reference = typeof data.reference === 'string' && data.reference !== '' ? data.reference : null;
  const storedData = Object.fromEntries(Object.entries(data).filter(([key]) => !UNSTORED_DATA_FIELDS.includes(key)));
  return {
    event,
    eventKey: webhookEventKey(event, data, rawBody),
    reference,
    payload: { event, data: storedData } as Prisma.InputJsonValue,
  };
}

/**
 * Paystack sends no event id, and redelivers the same body for the same occurrence. The subject of an event (the
 * transaction, refund or transfer) is `data.id`, falling back to our `data.reference`; one subject has at most one
 * event of each type, so `event:subject` identifies a delivery. A body with neither is keyed by its own digest,
 * which still collapses byte-identical redeliveries.
 */
export function webhookEventKey(event: string, data: Record<string, unknown>, rawBody: Buffer): string {
  if (typeof data.id === 'number' || (typeof data.id === 'string' && data.id !== '')) return `${event}:id:${data.id}`;
  if (typeof data.reference === 'string' && data.reference !== '') return `${event}:ref:${data.reference}`;
  return `${event}:sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

/**
 * One dispute gets several reminders, so its events are keyed by the dispute and its `updatedAt`, which changes with
 * every occurrence while a redelivery repeats it. Without `updatedAt` the body digest still collapses redeliveries.
 */
function disputeEventKey(event: string, disputeId: string, updatedAt: unknown, rawBody: Buffer): string {
  const version =
    typeof updatedAt === 'string' && updatedAt !== ''
      ? updatedAt
      : `sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
  return `${event}:dispute:${disputeId}:${version}`;
}

/** Events that settle a payment attempt by re-verifying its reference with Paystack. */
export function isSettlingEvent(event: string): boolean {
  return SETTLING_EVENTS.includes(event);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
