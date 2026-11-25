import { claimsGuestOrder, GUEST_PHONE_CLAIM_DAYS, GuestClaimRefusal, signUpPhoneClaim } from './guest-order-claims';

const PHONE = '+233244123456';
const OTHER_PHONE = '+233201234567';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('claimsGuestOrder', () => {
  it('attaches an unattached guest order placed with the same verified phone', () => {
    expect(claimsGuestOrder({ userId: null, guestPhone: PHONE }, PHONE)).toBe(true);
  });

  it('never across a different phone', () => {
    expect(claimsGuestOrder({ userId: null, guestPhone: PHONE }, OTHER_PHONE)).toBe(false);
  });

  it('never without a verified phone', () => {
    expect(claimsGuestOrder({ userId: null, guestPhone: PHONE }, null)).toBe(false);
  });

  it('never an order an account already holds', () => {
    expect(claimsGuestOrder({ userId: 'user1', guestPhone: PHONE }, PHONE)).toBe(false);
  });

  it('never an order placed by an account', () => {
    expect(claimsGuestOrder({ userId: 'user1', guestPhone: null }, PHONE)).toBe(false);
  });
});

describe('signUpPhoneClaim', () => {
  const now = new Date('2026-12-20T12:00:00Z');
  const verifiedAt = new Date(now.getTime() - DAY_MS);

  it("takes over the guest's verified phone and when it was verified", () => {
    expect(signUpPhoneClaim({ guestPhone: PHONE, guestPhoneVerifiedAt: verifiedAt }, false, now)).toEqual({
      phone: PHONE,
      verifiedAt,
    });
  });

  it('refuses a token that named no guest order', () => {
    expect(signUpPhoneClaim(null, false, now)).toEqual({ refused: GuestClaimRefusal.INVALID_GUEST_ORDER_TOKEN });
    expect(signUpPhoneClaim({ guestPhone: null, guestPhoneVerifiedAt: null }, false, now)).toEqual({
      refused: GuestClaimRefusal.INVALID_GUEST_ORDER_TOKEN,
    });
  });

  it(`refuses a verification older than ${GUEST_PHONE_CLAIM_DAYS} days`, () => {
    const old = new Date(now.getTime() - GUEST_PHONE_CLAIM_DAYS * DAY_MS - 1);
    expect(signUpPhoneClaim({ guestPhone: PHONE, guestPhoneVerifiedAt: old }, false, now)).toEqual({
      refused: GuestClaimRefusal.GUEST_VERIFICATION_EXPIRED,
    });
    const edge = new Date(now.getTime() - GUEST_PHONE_CLAIM_DAYS * DAY_MS);
    expect(signUpPhoneClaim({ guestPhone: PHONE, guestPhoneVerifiedAt: edge }, false, now)).toEqual({
      phone: PHONE,
      verifiedAt: edge,
    });
  });

  it('refuses a phone another account holds', () => {
    expect(signUpPhoneClaim({ guestPhone: PHONE, guestPhoneVerifiedAt: verifiedAt }, true, now)).toEqual({
      refused: GuestClaimRefusal.PHONE_IN_USE,
    });
  });
});
