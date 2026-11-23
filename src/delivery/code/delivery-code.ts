import { createHash, createHmac } from 'node:crypto';

/** How long a delivery code stays usable after dispatch; a delivery not confirmed by then needs a staff override. */
export const DELIVERY_CODE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Wrong entries allowed before the code locks (then only a staff override delivers). */
export const DELIVERY_CODE_MAX_ATTEMPTS = 5;

/** The two keys delivery codes use, derived from MFA_ENCRYPTION_KEY with their own labels (as the phone OTP key is). */
export interface DeliveryCodeKeys {
  /** Derives the code itself from the shipment and its dispatch. */
  codeKey: Buffer;
  /** Hashes the code stored in Redis, so a code read from Redis cannot be brute-forced without the server secret. */
  hashKey: Buffer;
}

export function deliveryCodeKeys(mfaKey: Buffer): DeliveryCodeKeys {
  return {
    codeKey: createHmac('sha256', mfaKey).update('delivery-code').digest(),
    hashKey: createHmac('sha256', mfaKey).update('delivery-code-hash').digest(),
  };
}

/**
 * Six digits fixed by the shipment and the time it went out: a retried SMS job sends the same code, and every new
 * dispatch (after a failed attempt) gets a new one. The modulo bias over 2^32 is below one in 4000.
 */
export function deliveryCode(codeKey: Buffer, shipmentId: string, dispatchedAt: Date): string {
  const digest = createHmac('sha256', codeKey).update(`${shipmentId}:${dispatchedAt.getTime()}`).digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

/** The code bound to the shipment and dispatch it was sent for. */
export function hashDeliveryCode(hashKey: Buffer, shipmentId: string, dispatchedAt: Date, code: string): string {
  return createHmac('sha256', hashKey).update(`${shipmentId}:${dispatchedAt.getTime()}:${code}`).digest('hex');
}

/** The Redis key holds a digest of the shipment id. */
export function deliveryCodeKey(shipmentId: string): string {
  return `delivery-code:${createHash('sha256').update(shipmentId).digest('hex')}`;
}

/**
 * The dispatch a code is sent for: a shipment with a rider that is (still) out for delivery. Shipments without a
 * rider (a courier, or staff delivering by hand) get no code and are delivered as before.
 */
export function deliveryCodeDispatch(shipment: {
  status: string;
  riderId: string | null;
  dispatchedAt: Date | null;
}): Date | null {
  return shipment.status === 'OUT_FOR_DELIVERY' && shipment.riderId ? shipment.dispatchedAt : null;
}

/** Appended to the out-for-delivery SMS, so the customer gets one message. */
export function withDeliveryCode(text: string, code: string): string {
  return `${text} Give the rider this code when you receive it: ${code}.`;
}

/** Codes are digits; a rider may type spaces. */
export function normaliseDeliveryCode(input: string): string {
  return input.replace(/\s+/g, '');
}
