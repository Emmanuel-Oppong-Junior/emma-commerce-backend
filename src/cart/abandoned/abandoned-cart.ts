import { createHash } from 'node:crypto';

/** A cart older than this is not reminded about: the customer has moved on. */
export const ABANDONED_CART_MAX_AGE_HOURS = 7 * 24;
/** At most one reminder per customer in this window, whatever their cart does. */
export const REMINDER_COOLDOWN_HOURS = 7 * 24;
export const DEFAULT_REMINDER_DELAY_HOURS = 4;

const HOUR_MS = 60 * 60 * 1000;

export interface CartLineFacts {
  variantId: string;
  quantity: number;
  updatedAt: Date;
}

export interface AbandonedCartFacts {
  lines: CartLineFacts[];
  /** When the customer last placed an order, if ever. */
  lastOrderAt: Date | null;
  /** The cart states the customer was already reminded about. */
  remindedStateHashes: string[];
  /** When the customer was last reminded, if ever. */
  lastRemindedAt: Date | null;
  /** Marketing consent on at least one channel the reminder can go on (email, or SMS to a verified phone). */
  hasMarketingConsent: boolean;
}

export type AbandonedCartSkip =
  'EMPTY' | 'TOO_RECENT' | 'TOO_OLD' | 'ORDERED_SINCE' | 'NO_CONSENT' | 'ALREADY_REMINDED' | 'REMINDED_RECENTLY';

export type AbandonedCartDecision = { remind: true; stateHash: string } | { remind: false; reason: AbandonedCartSkip };

/** Identifies what is in the cart (variants and quantities, in any order), so one state is reminded about once. */
export function cartStateHash(lines: readonly Pick<CartLineFacts, 'variantId' | 'quantity'>[]): string {
  const state = lines
    .map((line) => `${line.variantId}:${line.quantity}`)
    .sort()
    .join('|');
  return createHash('sha256').update(state).digest('hex');
}

/**
 * Whether a signed-in customer's cart gets an abandoned-cart reminder now: it has items, was last changed between
 * `delayHours` and 7 days ago, no order was placed since that change, the customer consented to marketing, this cart
 * state was never reminded about, and the customer had no reminder in the last 7 days.
 */
export function abandonedCartDecision(facts: AbandonedCartFacts, now: Date, delayHours: number): AbandonedCartDecision {
  if (facts.lines.length === 0) return { remind: false, reason: 'EMPTY' };
  const lastChangedAt = Math.max(...facts.lines.map((line) => line.updatedAt.getTime()));
  const idleMs = now.getTime() - lastChangedAt;
  if (idleMs < delayHours * HOUR_MS) return { remind: false, reason: 'TOO_RECENT' };
  if (idleMs > ABANDONED_CART_MAX_AGE_HOURS * HOUR_MS) return { remind: false, reason: 'TOO_OLD' };
  if (facts.lastOrderAt && facts.lastOrderAt.getTime() >= lastChangedAt)
    return { remind: false, reason: 'ORDERED_SINCE' };
  if (!facts.hasMarketingConsent) return { remind: false, reason: 'NO_CONSENT' };
  const stateHash = cartStateHash(facts.lines);
  if (facts.remindedStateHashes.includes(stateHash)) return { remind: false, reason: 'ALREADY_REMINDED' };
  if (facts.lastRemindedAt && now.getTime() - facts.lastRemindedAt.getTime() < REMINDER_COOLDOWN_HOURS * HOUR_MS) {
    return { remind: false, reason: 'REMINDED_RECENTLY' };
  }
  return { remind: true, stateHash };
}

/** "M, Red" from a variant's option values; empty for a default variant. */
export function variantLabel(optionValues: unknown): string {
  if (typeof optionValues !== 'object' || optionValues === null) return '';
  return Object.values(optionValues as Record<string, unknown>)
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .join(', ');
}
