import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '../generated/prisma/client';
import { ANONYMOUS_CUSTOMER, PricingPromotion } from '../pricing/price';
import type { PromotionPricingFacts } from '../promotions/promotions.service';
import {
  assertGuestPaymentMethod,
  assertGuestPhoneVerified,
  COUPON_NEEDS_ACCOUNT,
  GUEST_PHONE_NOT_VERIFIED,
  guestPayerEmail,
  guestPricingFacts,
  openToGuests,
} from './guest-checkout-rules';

const PHONE = '+233244123456';

function promotion(id: string, overrides: Partial<PricingPromotion> = {}): PricingPromotion {
  return {
    id,
    firstOrderOnly: false,
    customerGroupIds: [],
    perCustomerLimit: null,
    ...overrides,
  } as PricingPromotion;
}

function extensionsOf(run: () => unknown): Record<string, unknown> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { extensions: Record<string, unknown> }).extensions;
  }
  throw new Error('expected a refusal');
}

describe('openToGuests', () => {
  it('keeps promotions open to every visitor', () => {
    expect(openToGuests(promotion('p1'))).toBe(true);
  });

  it.each([
    ['first-order', { firstOrderOnly: true }],
    ['customer-group', { customerGroupIds: ['group1'] }],
    ['per-customer-limit', { perCustomerLimit: 1 }],
  ] as const)('leaves out %s promotions', (_, overrides) => {
    expect(openToGuests(promotion('p1', overrides))).toBe(false);
  });
});

describe('guestPricingFacts', () => {
  const customer = { redemptions: { p1: 1 }, groupIds: ['group1'], hasPriorOrder: true };

  it('prices a guest as a visitor with the promotions open to guests only', () => {
    const facts: PromotionPricingFacts = {
      promotions: [
        promotion('open'),
        promotion('limited', { perCustomerLimit: 2 }),
        promotion('first', { firstOrderOnly: true }),
      ],
      customer,
    };
    const priced = guestPricingFacts(facts);
    expect(priced.promotions.map((p) => p.id)).toEqual(['open']);
    expect(priced.customer).toEqual(ANONYMOUS_CUSTOMER);
  });

  it('keeps a public coupon', () => {
    const facts: PromotionPricingFacts = {
      promotions: [promotion('coupon', { requiresCoupon: true })],
      couponCode: { id: 'code1', promotionId: 'coupon' } as PromotionPricingFacts['couponCode'],
      customer: ANONYMOUS_CUSTOMER,
    };
    expect(guestPricingFacts(facts).couponCode).toEqual(facts.couponCode);
  });

  it('refuses a coupon whose promotion has a per-customer limit', () => {
    const facts: PromotionPricingFacts = {
      promotions: [promotion('coupon', { requiresCoupon: true, perCustomerLimit: 1 })],
      couponCode: { id: 'code1', promotionId: 'coupon' } as PromotionPricingFacts['couponCode'],
      customer: ANONYMOUS_CUSTOMER,
    };
    expect(extensionsOf(() => guestPricingFacts(facts))).toEqual({ reason: COUPON_NEEDS_ACCOUNT });
  });
});

describe('assertGuestPaymentMethod', () => {
  it('lets guests pay online', () => {
    expect(() => assertGuestPaymentMethod(PaymentMethod.ONLINE)).not.toThrow();
    expect(() => assertGuestPaymentMethod(undefined)).not.toThrow();
  });

  it('refuses cash on delivery for a guest', () => {
    expect(extensionsOf(() => assertGuestPaymentMethod(PaymentMethod.CASH_ON_DELIVERY))).toEqual({
      reason: 'COD_NOT_AVAILABLE',
      codReason: 'GUEST_CHECKOUT',
    });
  });
});

describe('assertGuestPhoneVerified', () => {
  const verifiedAt = new Date('2026-12-01T10:00:00Z');

  it('accepts the verified phone of the cart', () => {
    expect(() =>
      assertGuestPhoneVerified({ guestPhone: PHONE, guestPhoneVerifiedAt: verifiedAt }, PHONE),
    ).not.toThrow();
  });

  it.each([
    ['no phone', { guestPhone: null, guestPhoneVerifiedAt: null }, PHONE],
    ['a code sent but not confirmed', { guestPhone: PHONE, guestPhoneVerifiedAt: null }, PHONE],
    ['another phone than the verified one', { guestPhone: PHONE, guestPhoneVerifiedAt: verifiedAt }, '+233201234567'],
  ])('refuses %s', (_, cart, phone) => {
    expect(extensionsOf(() => assertGuestPhoneVerified(cart, phone))).toEqual({ reason: GUEST_PHONE_NOT_VERIFIED });
  });
});

describe('guestPayerEmail', () => {
  it("is an address at the storefront's own domain", () => {
    expect(guestPayerEmail('order1', 'https://shop.example.com/app')).toBe('guest-order-order1@shop.example.com');
  });
});
