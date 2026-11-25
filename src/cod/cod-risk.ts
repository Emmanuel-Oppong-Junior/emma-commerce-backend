import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

/** `extensions.reason` createOrder refuses cash on delivery with when the account's phone is not verified. */
export const PHONE_NOT_VERIFIED = 'PHONE_NOT_VERIFIED';
/** `extensions.reason` createOrder refuses cash on delivery with when a risk gate holds; `codReason` names the gate. */
export const COD_NOT_AVAILABLE = 'COD_NOT_AVAILABLE';

/** Why cash on delivery is not available for a checkout. Bounded: also the metric's `gate` label. */
export enum CodUnavailableReason {
  /** The store does not offer cash on delivery. */
  NOT_OFFERED = 'NOT_OFFERED',
  PHONE_NOT_VERIFIED = 'PHONE_NOT_VERIFIED',
  /** A phone or the delivery address is on the store's blacklist (not said which, so it cannot be probed). */
  BLOCKED = 'BLOCKED',
  /** The delivery zone does not take cash on delivery. */
  SHIPPING_ZONE_EXCLUDED = 'SHIPPING_ZONE_EXCLUDED',
  /** The verified phone already has the most open cash-on-delivery orders allowed. */
  OPEN_ORDER_LIMIT = 'OPEN_ORDER_LIMIT',
  /** The grand total is above the cash-on-delivery cap. */
  ORDER_TOTAL_ABOVE_CAP = 'ORDER_TOTAL_ABOVE_CAP',
  /** A guest checkout (P6-G.1): cash on delivery needs an account with a verified phone. */
  GUEST_CHECKOUT = 'GUEST_CHECKOUT',
}

export interface CodRiskSettings {
  maxOpenOrdersPerPhone: number;
  maxOrderTotal: Prisma.Decimal;
}

/** What the gates look at for one checkout. */
export interface CodCheckoutFacts {
  storeOffersCod: boolean;
  /** The account's phone when verified, else null. */
  verifiedPhone: string | null;
  blacklisted: boolean;
  /** Whether the delivery zone takes cash on delivery; null for pickup, which no zone gate applies to. */
  zoneCodEnabled: boolean | null;
  /** Open cash-on-delivery orders of the verified phone (or the account), not counting this one. */
  openCodOrders: number;
  grandTotal: Prisma.Decimal;
}

export const MAX_OPEN_ORDERS_LIMIT = 100;

/** The first gate that refuses cash on delivery, or null when it is available. */
export function codRefusal(facts: CodCheckoutFacts, settings: CodRiskSettings): CodUnavailableReason | null {
  if (!facts.storeOffersCod) return CodUnavailableReason.NOT_OFFERED;
  if (!facts.verifiedPhone) return CodUnavailableReason.PHONE_NOT_VERIFIED;
  if (facts.blacklisted) return CodUnavailableReason.BLOCKED;
  if (facts.zoneCodEnabled === false) return CodUnavailableReason.SHIPPING_ZONE_EXCLUDED;
  if (facts.openCodOrders >= settings.maxOpenOrdersPerPhone) return CodUnavailableReason.OPEN_ORDER_LIMIT;
  if (facts.grandTotal.gt(settings.maxOrderTotal)) return CodUnavailableReason.ORDER_TOTAL_ABOVE_CAP;
  return null;
}

const REFUSAL_MESSAGES: Record<CodUnavailableReason, string> = {
  NOT_OFFERED: 'Cash on delivery is not available at this store; pay online instead',
  PHONE_NOT_VERIFIED: 'Verify your phone number (requestPhoneVerification) to pay on delivery, or pay online',
  BLOCKED: 'Cash on delivery is not available for this phone number or address; pay online instead',
  SHIPPING_ZONE_EXCLUDED: 'Cash on delivery is not available in this delivery area; pay online instead',
  OPEN_ORDER_LIMIT: 'You have the most open cash-on-delivery orders allowed; pay online or wait for them to arrive',
  ORDER_TOTAL_ABOVE_CAP: 'This order is above the cash-on-delivery limit; pay online instead',
  GUEST_CHECKOUT: 'Cash on delivery needs an account with a verified phone; sign in or pay online',
};

/**
 * The createOrder refusal for a gate. NOT_OFFERED is normally refused earlier with PAYMENT_METHOD_UNAVAILABLE; it gets
 * here only when the switch was turned off during the checkout.
 */
export function codRefusalError(reason: CodUnavailableReason): BadRequestException {
  const extensions =
    reason === CodUnavailableReason.PHONE_NOT_VERIFIED
      ? { reason: PHONE_NOT_VERIFIED }
      : { reason: COD_NOT_AVAILABLE, codReason: reason };
  return new BadRequestException({ message: REFUSAL_MESSAGES[reason], extensions });
}

/** Refuses settings out of range: open orders a whole number from 1 to 100, the cap above 0 with at most 2 decimals. */
export function assertValidCodRiskSettings(update: Partial<CodRiskSettings>): void {
  const { maxOpenOrdersPerPhone, maxOrderTotal } = update;
  if (
    maxOpenOrdersPerPhone !== undefined &&
    (!Number.isInteger(maxOpenOrdersPerPhone) ||
      maxOpenOrdersPerPhone < 1 ||
      maxOpenOrdersPerPhone > MAX_OPEN_ORDERS_LIMIT)
  ) {
    throw new BadRequestException(
      `maxOpenOrdersPerPhone must be a whole number from 1 to ${MAX_OPEN_ORDERS_LIMIT}, got ${maxOpenOrdersPerPhone}`,
    );
  }
  if (maxOrderTotal !== undefined && (maxOrderTotal.lte(0) || maxOrderTotal.decimalPlaces() > 2)) {
    throw new BadRequestException(
      `maxOrderTotal must be above 0 with at most 2 decimals, got ${maxOrderTotal.toString()}`,
    );
  }
}
