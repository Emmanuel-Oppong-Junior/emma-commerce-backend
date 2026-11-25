/** No 0/O, 1/I/L: a code read out or typed from a flyer cannot be misread. */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERRAL_CODE_LENGTH = 8;

/** A new referral code: REFERRAL_CODE_LENGTH characters of the alphabet, drawn by `randomIndex` (crypto in production). */
export function generateReferralCode(randomIndex: (size: number) => number): string {
  return Array.from(
    { length: REFERRAL_CODE_LENGTH },
    () => REFERRAL_CODE_ALPHABET[randomIndex(REFERRAL_CODE_ALPHABET.length)],
  ).join('');
}

/** The code as stored (upper case, spaces and hyphens dropped), or null when it cannot be a referral code. */
export function normaliseReferralCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  if (code.length !== REFERRAL_CODE_LENGTH) return null;
  return [...code].every((char) => REFERRAL_CODE_ALPHABET.includes(char)) ? code : null;
}

export enum ReferralEntryRefusal {
  SELF_REFERRAL = 'SELF_REFERRAL',
  ALREADY_REFERRED = 'ALREADY_REFERRED',
  /** Codes are entered at sign-up or before the first order. */
  HAS_ORDERS = 'HAS_ORDERS',
  /** The code's owner was referred by this customer: two accounts cannot refer each other. */
  MUTUAL_REFERRAL = 'MUTUAL_REFERRAL',
  STAFF_ACCOUNT = 'STAFF_ACCOUNT',
}

/** Why the customer cannot enter this referrer's code, or null when they can. */
export function referralEntryRefusal(facts: {
  customerId: string;
  referrerId: string;
  /** Who referred the code's owner, if anyone. */
  referrerReferredBy: string | null;
  alreadyReferred: boolean;
  hasOrders: boolean;
  isStaff: boolean;
}): ReferralEntryRefusal | null {
  if (facts.customerId === facts.referrerId) return ReferralEntryRefusal.SELF_REFERRAL;
  if (facts.isStaff) return ReferralEntryRefusal.STAFF_ACCOUNT;
  if (facts.alreadyReferred) return ReferralEntryRefusal.ALREADY_REFERRED;
  if (facts.hasOrders) return ReferralEntryRefusal.HAS_ORDERS;
  if (facts.referrerReferredBy === facts.customerId) return ReferralEntryRefusal.MUTUAL_REFERRAL;
  return null;
}

export enum ReferralDisqualification {
  PHONE_NOT_VERIFIED = 'PHONE_NOT_VERIFIED',
  /** The new customer verified the phone the referrer holds. */
  SAME_PHONE = 'SAME_PHONE',
  LOYALTY_DISABLED = 'LOYALTY_DISABLED',
}

/**
 * Whether a referral qualifies when the new customer's first order completes: they need a verified phone that is not
 * the referrer's, and the loyalty programme must be on. Null when it qualifies.
 */
export function referralDisqualification(facts: {
  refereeVerifiedPhone: string | null;
  referrerPhones: readonly (string | null)[];
  loyaltyEnabled: boolean;
}): ReferralDisqualification | null {
  if (!facts.loyaltyEnabled) return ReferralDisqualification.LOYALTY_DISABLED;
  if (facts.refereeVerifiedPhone === null) return ReferralDisqualification.PHONE_NOT_VERIFIED;
  if (facts.referrerPhones.includes(facts.refereeVerifiedPhone)) return ReferralDisqualification.SAME_PHONE;
  return null;
}

/**
 * A rewarded referral is taken back when its qualifying order is refunded in full within the return window after it
 * completed (the rewards were given at completion).
 */
export function shouldReverseReferral(facts: {
  fullyRefunded: boolean;
  rewardedAt: Date;
  now: Date;
  returnWindowDays: number;
}): boolean {
  const windowMs = facts.returnWindowDays * 24 * 60 * 60 * 1000;
  return facts.fullyRefunded && facts.now.getTime() - facts.rewardedAt.getTime() <= windowMs;
}

/** What another customer may see of a referred customer: their first name, capitalised; never more. */
export function referralDisplayName(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0];
  if (!first) return 'A friend';
  return first.charAt(0).toUpperCase() + first.slice(1);
}
