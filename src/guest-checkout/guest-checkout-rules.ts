import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '../generated/prisma/client';
import { ANONYMOUS_CUSTOMER, PricingPromotion } from '../pricing/price';
import type { PromotionPricingFacts } from '../promotions/promotions.service';
import { codRefusalError, CodUnavailableReason } from '../cod/cod-risk';

/** `extensions.reason` when a guest enters a coupon whose promotion needs an account. */
export const COUPON_NEEDS_ACCOUNT = 'COUPON_NEEDS_ACCOUNT';
/** `extensions.reason` when a guest checks out before verifying the phone by SMS code. */
export const GUEST_PHONE_NOT_VERIFIED = 'GUEST_PHONE_NOT_VERIFIED';

/**
 * Whether a guest may get the promotion: guests are visitors, so not first-order or customer-group promotions, and
 * a per-customer limit needs an identity to count against, which a guest does not have.
 */
export function openToGuests(
  promotion: Pick<PricingPromotion, 'firstOrderOnly' | 'customerGroupIds' | 'perCustomerLimit'>,
) {
  return !promotion.firstOrderOnly && promotion.customerGroupIds.length === 0 && promotion.perCustomerLimit === null;
}

/**
 * The pricing facts of a guest checkout: the promotions open to guests and a visitor's (empty) history, so no
 * customer-group price lists either. A coupon unlocking a promotion that is not open to guests is refused.
 */
export function guestPricingFacts(facts: PromotionPricingFacts): PromotionPricingFacts {
  const couponPromotion =
    facts.couponCode && facts.promotions.find((promotion) => promotion.id === facts.couponCode!.promotionId);
  if (couponPromotion && !openToGuests(couponPromotion)) {
    throw new BadRequestException({
      message: 'This coupon needs an account: sign in or create one to use it',
      extensions: { reason: COUPON_NEEDS_ACCOUNT },
    });
  }
  return { ...facts, promotions: facts.promotions.filter(openToGuests), customer: ANONYMOUS_CUSTOMER };
}

/** A guest orders only with the phone verified by SMS code on the cart, and only that phone. */
export function assertGuestPhoneVerified(
  cart: { guestPhone: string | null; guestPhoneVerifiedAt: Date | null },
  phone: string,
): void {
  if (!cart.guestPhoneVerifiedAt || cart.guestPhone !== phone) {
    throw new BadRequestException({
      message: 'Verify your phone number with the code we text you (requestGuestPhoneVerification) before ordering',
      extensions: { reason: GUEST_PHONE_NOT_VERIFIED },
    });
  }
}

/**
 * The email a guest order without one opens its provider checkout with (Paystack requires an email): an address at
 * the storefront's own domain, so a provider receipt never goes to a third party.
 */
export function guestPayerEmail(orderId: string, frontendUrl: string): string {
  return `guest-order-${orderId}@${new URL(frontendUrl).hostname}`;
}

/** Guests pay online: cash on delivery stays with accounts whose phone is verified. */
export function assertGuestPaymentMethod(method: PaymentMethod | undefined): void {
  if (method === PaymentMethod.CASH_ON_DELIVERY) throw codRefusalError(CodUnavailableReason.GUEST_CHECKOUT);
}
