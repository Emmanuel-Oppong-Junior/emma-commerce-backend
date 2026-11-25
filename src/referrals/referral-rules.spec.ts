import {
  generateReferralCode,
  normaliseReferralCode,
  REFERRAL_CODE_ALPHABET,
  referralDisplayName,
  ReferralDisqualification,
  referralDisqualification,
  ReferralEntryRefusal,
  referralEntryRefusal,
  shouldReverseReferral,
} from './referral-rules';

const entry = (overrides: Partial<Parameters<typeof referralEntryRefusal>[0]> = {}) =>
  referralEntryRefusal({
    customerId: 'new',
    referrerId: 'friend',
    referrerReferredBy: null,
    alreadyReferred: false,
    hasOrders: false,
    isStaff: false,
    ...overrides,
  });

describe('referral rules (P6-L.2)', () => {
  it('generates 8-character codes without look-alike characters, and reads them back loosely', () => {
    let next = 0;
    const code = generateReferralCode((size) => next++ % size);
    expect(code).toBe('ABCDEFGH');
    expect(REFERRAL_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(normaliseReferralCode(' abcd-efgh ')).toBe('ABCDEFGH');
    expect(normaliseReferralCode('ABCDEFG0')).toBeNull();
    expect(normaliseReferralCode('ABCDEFG')).toBeNull();
  });

  it('lets a new customer enter one code, not their own, before any order, never mutual or for staff', () => {
    expect(entry()).toBeNull();
    expect(entry({ referrerId: 'new' })).toBe(ReferralEntryRefusal.SELF_REFERRAL);
    expect(entry({ alreadyReferred: true })).toBe(ReferralEntryRefusal.ALREADY_REFERRED);
    expect(entry({ hasOrders: true })).toBe(ReferralEntryRefusal.HAS_ORDERS);
    expect(entry({ referrerReferredBy: 'new' })).toBe(ReferralEntryRefusal.MUTUAL_REFERRAL);
    expect(entry({ isStaff: true })).toBe(ReferralEntryRefusal.STAFF_ACCOUNT);
  });

  it('qualifies only a new customer with a verified phone that is not the referrer’s, while loyalty is on', () => {
    const facts = {
      refereeVerifiedPhone: '+233244000001',
      referrerPhones: ['+233244000002', null],
      loyaltyEnabled: true,
    };
    expect(referralDisqualification(facts)).toBeNull();
    expect(referralDisqualification({ ...facts, refereeVerifiedPhone: null })).toBe(
      ReferralDisqualification.PHONE_NOT_VERIFIED,
    );
    expect(referralDisqualification({ ...facts, referrerPhones: ['+233244000001'] })).toBe(
      ReferralDisqualification.SAME_PHONE,
    );
    expect(referralDisqualification({ ...facts, loyaltyEnabled: false })).toBe(
      ReferralDisqualification.LOYALTY_DISABLED,
    );
  });

  it('reverses a reward only for a full refund within the return window', () => {
    const rewardedAt = new Date('2026-11-01T00:00:00Z');
    const at = (iso: string) => new Date(iso);
    expect(
      shouldReverseReferral({ fullyRefunded: true, rewardedAt, now: at('2026-11-15T00:00:00Z'), returnWindowDays: 14 }),
    ).toBe(true);
    expect(
      shouldReverseReferral({ fullyRefunded: true, rewardedAt, now: at('2026-11-15T00:00:01Z'), returnWindowDays: 14 }),
    ).toBe(false);
    expect(
      shouldReverseReferral({
        fullyRefunded: false,
        rewardedAt,
        now: at('2026-11-02T00:00:00Z'),
        returnWindowDays: 14,
      }),
    ).toBe(false);
  });

  it('shows only a first name', () => {
    expect(referralDisplayName('ama serwaa mensah')).toBe('Ama');
    expect(referralDisplayName('  ')).toBe('A friend');
    expect(referralDisplayName(null)).toBe('A friend');
  });
});
