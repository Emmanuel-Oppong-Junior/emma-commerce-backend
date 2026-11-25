import { ShipmentStatus } from '../../generated/prisma/client';
import { normaliseGhanaPhone } from '../../commons/phone/ghana-phone';

/**
 * The shipment milestones the customer gets an SMS for (P5-B.2): out for delivery and delivered. Ready for pickup is
 * sent by the pickup flow (P5-E), not here.
 */
export const SHIPMENT_SMS_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.DELIVERED,
];

export interface SmsRecipientFacts {
  /** The account's phone when verified (verifiedPhoneOf), already E.164. */
  verifiedPhone: string | null;
  /** The phone on the delivery address the order was placed with (its snapshot); null for pickup. */
  addressPhone: string | null;
  /** The contact phone given at checkout. */
  contactPhone: string | null;
}

/**
 * Who the milestone SMS goes to: the account's verified phone (proven to reach the customer), else the delivery
 * address phone (the person the rider will call), else the checkout contact phone; each only if it is a Ghana number
 * (the gateway sends locally). Null when none is usable.
 */
export function shipmentSmsRecipient(facts: SmsRecipientFacts): string | null {
  for (const phone of [facts.verifiedPhone, facts.addressPhone, facts.contactPhone]) {
    const normalised = phone ? normaliseGhanaPhone(phone) : null;
    if (normalised) return normalised;
  }
  return null;
}
