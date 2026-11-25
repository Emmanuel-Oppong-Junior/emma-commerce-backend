import { StoreFeatureKey } from '../generated/prisma/client';

export { StoreFeatureKey };

/** A feature stored in the StoreFeature table, which every feature is except cash on delivery. */
export type SwitchableFeature = Exclude<StoreFeatureKey, typeof StoreFeatureKey.CASH_ON_DELIVERY>;

export interface StoreFeatureDefinition {
  description: string;
  defaultEnabled: boolean;
  /**
   * The operations @RequireFeature refuses while the feature is off (as the authorization matrix names them). Reads of
   * existing data and staff operations stay open; feature-gates.spec checks this list against the decorators.
   */
  operations: readonly string[];
  /** What else changes inside other flows while it is off. */
  alsoOff: string;
}

/**
 * The store-level features (P8-F). Each is on unless a StoreFeature row says otherwise; cash on delivery is the
 * existing Store.cashOnDeliveryEnabled payment method switch, shown here so the admin sees every switch in one place.
 */
export const STORE_FEATURES: Record<StoreFeatureKey, StoreFeatureDefinition> = {
  GUEST_CHECKOUT: {
    description: 'Shoppers check out without an account, with a verified phone',
    defaultEnabled: true,
    operations: [
      'Mutation createGuestCart',
      'Mutation addToGuestCart',
      'Mutation updateGuestCartItem',
      'Mutation removeFromGuestCart',
      'Mutation requestGuestPhoneVerification',
      'Mutation verifyGuestPhone',
      'Query guestCheckoutQuote',
      'Mutation createGuestOrder',
    ],
    alsoOff: 'Guest cart changes and guest orders are refused; guest orders already placed can still be read and paid',
  },
  LOYALTY: {
    description: 'Customers earn loyalty points on completed orders and redeem them at checkout',
    defaultEnabled: true,
    operations: [],
    alsoOff:
      'No points are earned on completion nor redeemed at checkout; referrals are not rewarded. Balances stay, ' +
      'refunds still settle points, and staff can still adjust them',
  },
  REFERRALS: {
    description: 'Customers refer new customers with a code; both earn points on the first completed order',
    defaultEnabled: true,
    operations: ['Query myReferrals', 'Mutation applyReferralCode'],
    alsoOff:
      'signUp refuses a referral code; a referral whose first order completes meanwhile is disqualified ' +
      '(REFERRALS_DISABLED); rewarded referrals are still reversed on a full refund',
  },
  REVIEWS: {
    description: 'Verified buyers review products',
    defaultEnabled: true,
    operations: [
      'Mutation createReview',
      'Mutation updateReview',
      'Mutation deleteReview',
      'Mutation removeReviewPhoto',
      'Mutation reportReview',
      'REST POST /reviews/:reviewId/photos',
    ],
    alsoOff: 'Published reviews stay readable and staff can still moderate them',
  },
  PRODUCT_QA: {
    description: 'Customers ask questions about products and the store answers',
    defaultEnabled: true,
    operations: ['Mutation askProductQuestion', 'Mutation reportProductQuestion'],
    alsoOff: 'Answered questions stay readable and staff can still answer and moderate',
  },
  RECENTLY_VIEWED: {
    description: 'Signed-in customers keep a list of the products they viewed',
    defaultEnabled: true,
    operations: ['Mutation recordProductView'],
    alsoOff: 'The list recorded so far stays readable',
  },
  RETURNS: {
    description: 'Customers request returns of delivered goods',
    defaultEnabled: true,
    operations: ['Mutation requestReturn', 'Mutation cancelReturn', 'REST POST /returns/orders/:orderId/photos'],
    alsoOff: 'Customers still see their returns; staff still process open ones and can accept returns themselves',
  },
  ABANDONED_CART_REMINDERS: {
    description: 'Customers with marketing consent are reminded of carts they left',
    defaultEnabled: true,
    operations: [],
    alsoOff: 'The hourly reminder job records no reminders',
  },
  SAVED_FOR_LATER: {
    description: 'Customers move cart lines to a saved-for-later list',
    defaultEnabled: true,
    operations: ['Mutation saveCartItemForLater', 'Mutation moveSavedItemToCart', 'Mutation removeSavedItem'],
    alsoOff: 'Saved items stay readable',
  },
  WISHLIST: {
    description: 'Customers keep a wishlist of products',
    defaultEnabled: true,
    operations: ['Mutation addToWishlist', 'Mutation removeFromWishlist', 'Mutation clearWishlist'],
    alsoOff: 'The wishlist stays readable',
  },
  CASH_ON_DELIVERY: {
    description: 'Customers pay cash when the order is delivered or collected (the payment method switch)',
    defaultEnabled: true,
    operations: [],
    alsoOff: 'Checkout refuses cash on delivery (PAYMENT_METHOD_UNAVAILABLE), as updatePaymentMethods does',
  },
};

export const STORE_FEATURE_KEYS = Object.keys(STORE_FEATURES) as StoreFeatureKey[];

export const SWITCHABLE_FEATURES = STORE_FEATURE_KEYS.filter(
  (key): key is SwitchableFeature => key !== StoreFeatureKey.CASH_ON_DELIVERY,
);

/** Each switchable feature's value: the stored row's, else the default. */
export function resolveFeatures(
  rows: readonly { key: StoreFeatureKey; enabled: boolean }[],
): Record<SwitchableFeature, boolean> {
  const stored = new Map(rows.map((row) => [row.key, row.enabled]));
  return Object.fromEntries(
    SWITCHABLE_FEATURES.map((key) => [key, stored.get(key) ?? STORE_FEATURES[key].defaultEnabled]),
  ) as Record<SwitchableFeature, boolean>;
}
