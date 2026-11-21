import { Decimal } from '@prisma/client/runtime/client';
import { Currency, OrderAdjustmentType, PromotionScope, PromotionType } from '../generated/prisma/client';
import { Money, roundHalfUp } from '../commons/money/money';
import { quoteHash } from './quote-hash';

/** The pricing rules `price` implements; stored on every order it priced (legacy orders have 0). */
export const PRICING_VERSION = 3;

export interface PricingLine {
  variantId: string;
  productId: string;
  categoryId: string | null;
  brandId: string | null;
  quantity: number;
  /** One unit, in whole pesewas. It includes the active taxes when `taxable`. */
  unitListPrice: Decimal;
  /** The price had the active tax rates added to it (a taxable product's variant with a basePrice). */
  taxable: boolean;
}

export interface PricingPromotion {
  id: string;
  /** Shown to customers; never changes the price. */
  name: string;
  description: string | null;
  scope: PromotionScope;
  type: PromotionType;
  /** The reduction (BXGY: the percentage off each reward unit); null only for TIERED, whose tiers carry it. */
  value: Decimal | null;
  /** BXGY: units of the targets to buy, and reward units got, per application; at most maxApplications of them. */
  buyQuantity: number | null;
  getQuantity: number | null;
  maxApplications: number | null;
  /** BXGY: the reward units' targets, of the scope's kind; empty for the targets themselves. */
  rewardTargetIds: readonly string[];
  /** TIERED: how the reached tier's value reduces the price (PERCENT, AMOUNT_OFF or FIXED_PRICE). */
  tierValueType: PromotionType | null;
  /** TIERED: by minimumQuantity of targeted units (item scopes) or minimumSpend (CART). */
  tiers: readonly PricingTier[];
  /** FREE_SHIPPING: only for deliveries to these zones; empty for every zone. */
  shippingZoneIds: readonly string[];
  minimumSpend: Decimal | null;
  minimumQuantity: number | null;
  startsAt: Date;
  endsAt: Date | null;
  isActive: boolean;
  priority: number;
  stackingGroup: string;
  exclusive: boolean;
  requiresCoupon: boolean;
  usageLimit: number | null;
  usedCount: number;
  /** Units that may be sold at the promotional price across all orders (a flash sale); null for no cap. */
  unitCap: number | null;
  /** Units sold at the promotional price by orders holding a redemption. */
  unitsUsed: number;
  perCustomerLimit: number | null;
  /** Only for a customer without a prior order (PricingCustomer.hasPriorOrder). */
  firstOrderOnly: boolean;
  /** Only for members of one of these customer groups; empty for everyone. */
  customerGroupIds: readonly string[];
  createdAt: Date;
  /** What it targets, of its scope's kind: variant ids (SKU), product, category or brand ids; none for CART. */
  targetIds: readonly string[];
}

export interface PricingTier {
  minimumQuantity: number | null;
  minimumSpend: Decimal | null;
  value: Decimal;
}

/** The coupon code entered at checkout; it unlocks its promotion. */
export interface PricingCouponCode {
  id: string;
  code: string;
  promotionId: string;
  isActive: boolean;
  usageLimit: number | null;
  usedCount: number;
}

/** What the engine knows about the customer, read with the cart. */
export interface PricingCustomer {
  /** The customer's RESERVED redemptions, by promotion id. */
  redemptions: Readonly<Record<string, number>>;
  /** The customer groups the customer belongs to. */
  groupIds: readonly string[];
  /** The customer has an earlier order that reached CONFIRMED (or later) or PAYMENT_REVIEW. */
  hasPriorOrder: boolean;
}

/** A visitor: no redemptions, no groups, no orders (product pages). */
export const ANONYMOUS_CUSTOMER: PricingCustomer = { redemptions: {}, groupIds: [], hasPriorOrder: false };

export interface PricingTaxRate {
  id: string;
  name: string;
  rate: Decimal;
}

/** What is being bought. */
export interface PricingCart {
  lines: readonly PricingLine[];
  couponCode?: PricingCouponCode;
  /** The fee of the chosen fulfilment: the delivery zone's fee, or 0 for pickup. */
  shippingFee: Decimal;
  /** The delivery zone; null for pickup. */
  shippingZoneId: string | null;
}

/** Everything else the price depends on, read at one moment. */
export interface PricingContext {
  currency: Currency;
  now: Date;
  /** Candidate promotions (the coupon code's among them); the engine decides which apply where. */
  promotions: readonly PricingPromotion[];
  /** The active taxes, whose rates taxable prices include. */
  taxRates: readonly PricingTaxRate[];
  customer: PricingCustomer;
}

/** A reduction with its source promotion; amounts are negative. */
export interface QuoteAdjustment {
  type: OrderAdjustmentType;
  sourceId: string;
  code: string | null;
  amount: Decimal;
}

/** An order-level reduction and its share of each line (largest remainder, ADR-0004), in `Quote.lines` order. */
export interface QuoteOrderAdjustment extends QuoteAdjustment {
  allocations: Decimal[];
}

export interface QuoteTaxLine {
  taxId: string;
  name: string;
  rate: Decimal;
  /** The line's amount without tax. */
  base: Decimal;
  amount: Decimal;
}

/**
 * Units of one cart line that pay the same price. A cart line is one quote line, unless a promotion reduces only some
 * of its units (a flash sale's last units): then it is split, the reduced units first.
 */
export interface QuoteLine {
  /** The cart line it prices (its index in PricingCart.lines). */
  cartLineIndex: number;
  variantId: string;
  productId: string;
  quantity: number;
  unitListPrice: Decimal;
  unitDiscount: Decimal;
  /** One unit after its discount, without tax. */
  unitNet: Decimal;
  /** Tax included in one discounted unit. */
  unitTax: Decimal;
  /** (unitListPrice - unitDiscount) × quantity = (unitNet + unitTax) × quantity. */
  lineTotal: Decimal;
  /** The item promotions taken off the line (already in unitDiscount). */
  adjustments: QuoteAdjustment[];
  taxLines: QuoteTaxLine[];
}

export type UnhashedQuote = Omit<Quote, 'quoteHash'>;

/**
 * Every amount is exact to the pesewa and
 *   grandTotal = Σ unitNet × quantity + Σ order adjustments + taxTotal + shippingTotal
 *              = subtotal - discountTotal + shippingTotal,
 *   shippingTotal = the fee + Σ shipping adjustments.
 */
export interface Quote {
  currency: Currency;
  pricingVersion: number;
  /** In the order of the cart's lines (a split cart line's quote lines next to each other). */
  lines: QuoteLine[];
  /** The cart promotions that take something off. */
  adjustments: QuoteOrderAdjustment[];
  /** The free-shipping promotions that take something off the delivery fee (already in shippingTotal). */
  shippingAdjustments: QuoteAdjustment[];
  /** Σ unitListPrice × quantity. */
  subtotal: Decimal;
  /** Item discounts plus order adjustments (merchandise only, not shipping), as a positive amount. */
  discountTotal: Decimal;
  taxTotal: Decimal;
  /** The delivery fee after free-shipping promotions. */
  shippingTotal: Decimal;
  /** The delivery zone priced (null for pickup): zone-limited free shipping depends on it. */
  shippingZoneId: string | null;
  /** The amount to charge. */
  grandTotal: Decimal;
  /** SHA-256 of every value that determines the charge (see quote-hash.ts). */
  quoteHash: string;
}

/** The coupon code cannot be used on this cart; the message says why and is safe to show the customer. */
export class CouponNotApplicableError extends Error {}

/**
 * Prices a cart (ADR-0005 §3). Pure: the same cart and context always give the same quote and hash, whatever order
 * the lines, promotions or taxes come in. A promotion is a candidate when it is active, in its schedule, within its
 * usage limits (and with units left, under a unit cap), open to the customer (first order only: no prior order;
 * customer groups: a member of one), and unlocked by the coupon code if it requires one. The rules (PRICING_VERSION 3):
 * - item level (SKU, PRODUCT, CATEGORY, BRAND): a candidate offers to reduce the units of the lines it targets when
 *   the list-price subtotal reaches its minimum spend and the targeted units its minimum quantity. Under a unit cap
 *   (a flash sale) it offers only the units left, those it saves the most on at the list price first (then by
 *   variant); the rest of a line pays the normal price, so the line is split. TIERED counts the targeted units of all
 *   lines together and offers every one of them its reached tier; BXGY counts buy and reward units across lines and
 *   offers the cheapest reward units value percent off, once per buyQuantity other buy units (rewardOffers). These
 *   lines are split too. On each unit, every stacking group
 *   contributes the offer saving the most on it at the list price; the groups' winners then apply one after the other
 *   (lowest priority number first, then the oldest), each on what the unit still costs, so a unit never goes below
 *   zero;
 * - cart level (CART): a candidate applies when the subtotal after item promotions (before shipping and tax is added;
 *   prices include tax) reaches its minimum spend and the cart's units its minimum quantity; a TIERED one (spend X,
 *   save Y) applies as the highest tier that subtotal reaches. Every stacking group
 *   contributes the promotion saving the most on that subtotal; the winners apply one after the other on what is left,
 *   each allocated to the lines by largest remainder;
 * - shipping level (FREE_SHIPPING, CART scope): a candidate applies when the delivery zone is one of its zones (or it
 *   has none) and the subtotal after item and cart promotions reaches its minimum spend; it waives the fee (no value)
 *   or takes value off it, never below zero. One winner per stacking group, applied in priority order on what is left
 *   of the fee. Pickup has no fee, so it saves nothing there;
 * - exclusive: when exclusive candidates save anything, only the one saving the most on the whole cart applies, alone
 *   (an item one on the units it offers, a cart one on the list-price subtotal, a shipping one on the fee), and no
 *   other promotion does;
 * - every tie between equal savings goes to the lowest priority number, then the oldest promotion (createdAt, id);
 * - a taxable price includes the active taxes: per unit, the net is the discounted price over (1 + Σ rates), rounded
 *   half-up, the tax is the rest, split over the rates by largest remainder; cart promotions and shipping are untaxed.
 * A coupon code whose promotion cannot be used throws CouponNotApplicableError; one that loses to an exclusive or a
 * better promotion simply takes nothing off.
 */
export function price(cart: PricingCart, context: PricingContext): Quote {
  const unhashed = priceWithoutHash(cart, context);
  return { ...unhashed, quoteHash: quoteHash(unhashed) };
}

function priceWithoutHash(cart: PricingCart, context: PricingContext): UnhashedQuote {
  const { currency } = context;
  const money = (value: Decimal.Value) => Money.of(value, currency);
  const zero = Money.zero(currency);
  cart.lines.forEach(assertValidLine);
  const taxRates = canonicalTaxRates(context.taxRates);
  const couponPromotion = cart.couponCode && couponPromotionOf(cart.couponCode, context);
  const candidates = context.promotions.filter((promotion) => isCandidate(promotion, cart.couponCode, context));

  const grossSubtotal = cart.lines.reduce((sum, line) => sum.add(money(line.unitListPrice).times(line.quantity)), zero);
  const cartQuantity = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (couponPromotion && couponPromotion.scope !== PromotionScope.CART) {
    assertItemCouponApplies(couponPromotion, cart.lines, grossSubtotal.amount);
  }
  const itemOffers = candidates
    .filter(
      (promotion) =>
        promotion.scope !== PromotionScope.CART &&
        reachesMinimums(promotion, grossSubtotal.amount, targetedQuantity(promotion, cart.lines)),
    )
    .flatMap((promotion) => offersOf(promotion, cart.lines));
  const fee = money(cart.shippingFee);
  if (fee.isNegative() || !fee.equals(fee.roundHalfUp())) {
    throw new RangeError(`Shipping must be whole pesewas and not negative, got ${fee.amount.toString()}`);
  }
  const coversZone = (promotion: PricingPromotion) =>
    promotion.shippingZoneIds.length === 0 ||
    (cart.shippingZoneId !== null && promotion.shippingZoneIds.includes(cart.shippingZoneId));
  const exclusive = bestExclusive(
    cart.lines,
    itemOffers,
    candidates.filter(
      (promotion) =>
        (isCartLevel(promotion) || (isShippingLevel(promotion) && coversZone(promotion))) &&
        reachesMinimums(promotion, grossSubtotal.amount, cartQuantity),
    ),
    grossSubtotal.amount,
    fee.amount,
  );
  const allowed = (promotion: PricingPromotion) => (exclusive ? promotion === exclusive : !promotion.exclusive);

  const allowedOffers = itemOffers.filter((offer) => allowed(offer.promotion));
  const lines = cart.lines.flatMap((line, lineIndex) =>
    unitGroups(
      line,
      allowedOffers.filter((offer) => offer.lineIndex === lineIndex),
    ).map(({ quantity, discount }) => priceLine(line, lineIndex, quantity, discount, taxRates, money, cart.couponCode)),
  );

  const merchandise = lines.reduce((sum, line) => sum.add(money(line.lineTotal)), zero);
  if (couponPromotion && isCartLevel(couponPromotion)) {
    const rejection = minimumsRejection(couponPromotion, merchandise.amount, cartQuantity);
    if (rejection) throw new CouponNotApplicableError(rejection);
  }
  const cartCandidates = candidates.filter(
    (promotion) =>
      isCartLevel(promotion) && allowed(promotion) && reachesMinimums(promotion, merchandise.amount, cartQuantity),
  );
  const adjustments: QuoteOrderAdjustment[] = [];
  const remaining = lines.map((line) => money(line.lineTotal));
  const cartRules = new Map(cartCandidates.map((each) => [each, cartRule(each, merchandise.amount)]));
  const savingOn = (subtotal: Decimal, promotion: PricingPromotion) =>
    cartSaving(subtotal, cartRules.get(promotion) ?? null);
  for (const promotion of groupWinners(cartCandidates, (each) => savingOn(merchandise.amount, each))) {
    const left = remaining.reduce((sum, amount) => sum.add(amount), zero);
    const saving = savingOn(left.amount, promotion);
    if (!saving.gt(0)) continue;
    const shares = allocateToLines(money(saving), lines, remaining);
    shares.forEach((share, index) => (remaining[index] = remaining[index].subtract(share)));
    adjustments.push({
      ...adjustmentFrom(promotion, saving, cart.couponCode),
      allocations: shares.map((share) => negate(share.amount)),
    });
  }

  const afterCart = remaining.reduce((sum, amount) => sum.add(amount), zero);
  if (couponPromotion && isShippingLevel(couponPromotion)) {
    const rejection = minimumsRejection(couponPromotion, afterCart.amount, cartQuantity);
    if (rejection) throw new CouponNotApplicableError(rejection);
    // A pickup order has no zone and no fee: the code does nothing there, which is not an error.
    if (cart.shippingZoneId !== null && !coversZone(couponPromotion)) {
      throw new CouponNotApplicableError('This coupon does not cover delivery to your area');
    }
  }
  const shippingCandidates = candidates.filter(
    (promotion) =>
      isShippingLevel(promotion) &&
      allowed(promotion) &&
      coversZone(promotion) &&
      reachesMinimums(promotion, afterCart.amount, cartQuantity),
  );
  const shippingAdjustments: QuoteAdjustment[] = [];
  let shipping = fee;
  for (const promotion of groupWinners(shippingCandidates, (each) => feeSaving(fee.amount, each))) {
    const saving = feeSaving(shipping.amount, promotion);
    if (!saving.gt(0)) continue;
    shippingAdjustments.push(adjustmentFrom(promotion, saving, cart.couponCode));
    shipping = shipping.subtract(money(saving));
  }

  const itemDiscounts = lines.reduce((sum, line) => sum.add(money(line.unitDiscount).times(line.quantity)), zero);
  const orderDiscounts = adjustments.reduce((sum, adjustment) => sum.subtract(money(adjustment.amount)), zero);
  const discountTotal = itemDiscounts.add(orderDiscounts);
  const taxTotal = lines.reduce((sum, line) => sum.add(money(line.unitTax).times(line.quantity)), zero);

  return {
    currency,
    pricingVersion: PRICING_VERSION,
    lines,
    adjustments,
    shippingAdjustments,
    subtotal: grossSubtotal.amount,
    discountTotal: discountTotal.amount,
    taxTotal: taxTotal.amount,
    shippingTotal: shipping.amount,
    shippingZoneId: cart.shippingZoneId,
    grandTotal: grossSubtotal.subtract(discountTotal).add(shipping).amount,
  };
}

/** Active and within its schedule at `now`. */
export function isLive(promotion: PricingPromotion, now: Date): boolean {
  return promotion.isActive && promotion.startsAt <= now && (promotion.endsAt === null || promotion.endsAt >= now);
}

function hasUsesLeft(promotion: PricingPromotion): boolean {
  return promotion.usageLimit === null || promotion.usedCount < promotion.usageLimit;
}

/** Units the promotion may still sell at its price; Infinity without a unit cap. */
export function unitsLeft(promotion: Pick<PricingPromotion, 'unitCap' | 'unitsUsed'>): number {
  return promotion.unitCap === null ? Infinity : Math.max(0, promotion.unitCap - promotion.unitsUsed);
}

function customerHasUsesLeft(promotion: PricingPromotion, customer: PricingCustomer): boolean {
  return promotion.perCustomerLimit === null || (customer.redemptions[promotion.id] ?? 0) < promotion.perCustomerLimit;
}

/** Why the promotion is not open to the customer (first order only, customer groups), or null when it is. */
function audienceRejection(promotion: PricingPromotion, customer: PricingCustomer): string | null {
  if (promotion.firstOrderOnly && customer.hasPriorOrder) return 'This coupon is only for a first order';
  if (
    promotion.customerGroupIds.length > 0 &&
    !promotion.customerGroupIds.some((groupId) => customer.groupIds.includes(groupId))
  ) {
    return 'This coupon is not available for your account';
  }
  return null;
}

function isCandidate(
  promotion: PricingPromotion,
  couponCode: PricingCouponCode | undefined,
  context: PricingContext,
): boolean {
  return (
    isLive(promotion, context.now) &&
    hasUsesLeft(promotion) &&
    unitsLeft(promotion) > 0 &&
    customerHasUsesLeft(promotion, context.customer) &&
    audienceRejection(promotion, context.customer) === null &&
    (!promotion.requiresCoupon || couponCode?.promotionId === promotion.id)
  );
}

/** Whether the item promotion targets the line (its variant, product, category or brand); never for CART. */
export function targets(promotion: PricingPromotion, line: Pick<PricingLine, TargetKey>): boolean {
  const id = targetOf(promotion.scope, line);
  return id !== null && promotion.targetIds.includes(id);
}

type TargetKey = 'variantId' | 'productId' | 'categoryId' | 'brandId';

function targetOf(scope: PromotionScope, line: Pick<PricingLine, TargetKey>): string | null {
  switch (scope) {
    case PromotionScope.SKU:
      return line.variantId;
    case PromotionScope.PRODUCT:
      return line.productId;
    case PromotionScope.CATEGORY:
      return line.categoryId;
    case PromotionScope.BRAND:
      return line.brandId;
    case PromotionScope.CART:
      return null;
  }
}

function targetedQuantity(promotion: PricingPromotion, lines: readonly PricingLine[]): number {
  return lines.reduce((sum, line) => sum + (targets(promotion, line) ? line.quantity : 0), 0);
}

function reachesMinimums(promotion: PricingPromotion, spend: Decimal, quantity: number): boolean {
  return minimumsRejection(promotion, spend, quantity) === null;
}

function minimumsRejection(promotion: PricingPromotion, spend: Decimal, quantity: number): string | null {
  if (promotion.minimumSpend !== null && spend.lt(promotion.minimumSpend)) {
    return `Order total must be at least ${promotion.minimumSpend.toString()} to use this coupon`;
  }
  if (promotion.minimumQuantity !== null && quantity < promotion.minimumQuantity) {
    return `Add at least ${promotion.minimumQuantity} eligible items to use this coupon`;
  }
  return null;
}

/**
 * Why the coupon code cannot be used by this customer, whatever the cart, or null when it can: the code and its
 * promotion must be active and in date, with uses (and units, under a unit cap) left overall and uses left for the
 * customer, and open to the customer.
 */
export function couponCodeRejection(
  couponCode: PricingCouponCode,
  promotion: PricingPromotion,
  customer: PricingCustomer,
  now: Date,
): string | null {
  if (!couponCode.isActive || !promotion.isActive) return 'This coupon is no longer active';
  if (promotion.startsAt > now) return 'This coupon is not active yet';
  if (promotion.endsAt !== null && promotion.endsAt < now) return 'This coupon has expired';
  if (!hasUsesLeft(promotion) || (couponCode.usageLimit !== null && couponCode.usedCount >= couponCode.usageLimit)) {
    return 'This coupon has reached its usage limit';
  }
  if (unitsLeft(promotion) === 0) return 'This offer has sold out';
  if (!customerHasUsesLeft(promotion, customer)) return 'You have already used this coupon';
  return audienceRejection(promotion, customer);
}

function couponPromotionOf(couponCode: PricingCouponCode, context: PricingContext): PricingPromotion {
  const promotion = context.promotions.find((candidate) => candidate.id === couponCode.promotionId);
  if (!promotion) throw new Error(`The promotion of coupon code "${couponCode.code}" is not among the candidates`);
  const rejection = couponCodeRejection(couponCode, promotion, context.customer, context.now);
  if (rejection) throw new CouponNotApplicableError(rejection);
  return promotion;
}

function assertItemCouponApplies(promotion: PricingPromotion, lines: readonly PricingLine[], spend: Decimal): void {
  const quantity = targetedQuantity(promotion, lines);
  if (quantity === 0) throw new CouponNotApplicableError('This coupon does not apply to any item in your cart');
  const rejection = minimumsRejection(promotion, spend, quantity);
  if (rejection) throw new CouponNotApplicableError(rejection);
}

export interface UnitPromotion {
  /** What the promotion took off one unit, after the ones applied before it. */
  unitSaving: Decimal;
  promotion: PricingPromotion;
}

export interface UnitPromotions {
  unitDiscount: Decimal;
  /** The promotions taken, in the order they applied, each saving something. */
  applied: UnitPromotion[];
}

/** How a promotion reduces one unit (or the cart subtotal), once the engine knows it applies. */
interface Rule {
  type: PromotionType;
  value: Decimal;
}

/** A promotion's offer to reduce a unit by `rule`. */
interface UnitOffer {
  promotion: PricingPromotion;
  rule: Rule;
}

/** A promotion's offer to reduce the first `units` units of cart line `lineIndex`, before it competes with others. */
interface LineOffer extends UnitOffer {
  lineIndex: number;
  units: number;
}

const SIMPLE_TYPES: readonly PromotionType[] = [
  PromotionType.PERCENT,
  PromotionType.AMOUNT_OFF,
  PromotionType.FIXED_PRICE,
];

/** The rule of a PERCENT, AMOUNT_OFF or FIXED_PRICE promotion. */
function ownRule(promotion: PricingPromotion): Rule {
  if (!SIMPLE_TYPES.includes(promotion.type) || promotion.value === null) {
    throw new Error(`Promotion "${promotion.id}" (${promotion.type}) has no single rule`);
  }
  return { type: promotion.type, value: promotion.value };
}

/** The tier with the highest threshold that `reached` reaches (tiers never lose value going up), as a rule. */
function tierRule(promotion: PricingPromotion, reached: (tier: PricingTier) => boolean): Rule | null {
  const tier = [...promotion.tiers]
    .filter(reached)
    .sort(
      (a, b) => (a.minimumQuantity ?? 0) - (b.minimumQuantity ?? 0) || compareDecimals(a.minimumSpend, b.minimumSpend),
    )
    .pop();
  return tier && promotion.tierValueType ? { type: promotion.tierValueType, value: tier.value } : null;
}

/** What a cart promotion applies as on a cart whose merchandise is worth `spend`: its own rule or its reached tier. */
function cartRule(promotion: PricingPromotion, spend: Decimal): Rule | null {
  return promotion.type === PromotionType.TIERED
    ? tierRule(promotion, (tier) => tier.minimumSpend !== null && spend.gte(tier.minimumSpend))
    : ownRule(promotion);
}

/**
 * The units an item promotion offers to reduce, at list prices: every unit of the lines it targets (TIERED: at the
 * tier the targeted units reach together), the BXGY reward units, or, under a unit cap, only the units left, those it
 * saves the most on first (then by variant; BXGY caps whole applications).
 */
function offersOf(promotion: PricingPromotion, lines: readonly PricingLine[]): LineOffer[] {
  if (promotion.type === PromotionType.BXGY) return rewardOffers(promotion, lines);
  const quantity = targetedQuantity(promotion, lines);
  const rule =
    promotion.type === PromotionType.TIERED
      ? tierRule(promotion, (tier) => tier.minimumQuantity !== null && quantity >= tier.minimumQuantity)
      : ownRule(promotion);
  if (!rule) return [];
  const offers = lines.flatMap((line, lineIndex) =>
    targets(promotion, line) ? [{ promotion, rule, lineIndex, units: line.quantity }] : [],
  );
  return promotion.unitCap === null ? offers : withinCap(offers, unitsLeft(promotion), lines);
}

/**
 * BXGY, mix and match: every unit of the buy targets counts towards buyQuantity and every unit of the reward targets
 * can be a reward, across lines. It applies as many times as it can (at most maxApplications, and within the units
 * left under a cap), each time rewarding the cheapest reward units not yet rewarded with value percent off, while
 * enough other buy units are left to pay for them: a unit is never both bought and rewarded.
 */
function rewardOffers(promotion: PricingPromotion, lines: readonly PricingLine[]): LineOffer[] {
  const buy = promotion.buyQuantity!;
  const get = promotion.getQuantity!;
  const rewardIds = promotion.rewardTargetIds.length > 0 ? promotion.rewardTargetIds : promotion.targetIds;
  const isReward = (line: PricingLine) => {
    const id = targetOf(promotion.scope, line);
    return id !== null && rewardIds.includes(id);
  };
  const cheapestFirst = lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) => isReward(line))
    .sort((a, b) => a.line.unitListPrice.comparedTo(b.line.unitListPrice) || compareLines(a.line, b.line));
  const rewardUnits = cheapestFirst.reduce((sum, { line }) => sum + line.quantity, 0);
  const rewardsFor = (applications: number) => {
    const rewarded = new Map<number, number>();
    let wanted = applications * get;
    for (const { line, lineIndex } of cheapestFirst) {
      const units = Math.min(line.quantity, wanted);
      if (units > 0) rewarded.set(lineIndex, units);
      wanted -= units;
    }
    return rewarded;
  };
  const affordable = (applications: number) => {
    const rewarded = rewardsFor(applications);
    const buyUnits = lines.reduce(
      (sum, line, index) => sum + (targets(promotion, line) ? line.quantity - (rewarded.get(index) ?? 0) : 0),
      0,
    );
    return buyUnits >= applications * buy;
  };
  // More applications only take more reward units and need more buy units, so the affordable ones are 0..n.
  let low = 0;
  let high = Math.min(
    Math.floor(rewardUnits / get),
    promotion.maxApplications ?? Infinity,
    Math.floor(unitsLeft(promotion) / get),
  );
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (affordable(middle)) low = middle;
    else high = middle - 1;
  }
  const rule: Rule = { type: PromotionType.PERCENT, value: promotion.value! };
  return [...rewardsFor(low)].map(([lineIndex, units]) => ({ promotion, rule, lineIndex, units }));
}

function withinCap(offers: readonly LineOffer[], cap: number, lines: readonly PricingLine[]): LineOffer[] {
  const saving = (offer: LineOffer) => unitSaving(lines[offer.lineIndex].unitListPrice, offer.rule);
  const ranked = [...offers].sort(
    (a, b) => saving(b).comparedTo(saving(a)) || compareLines(lines[a.lineIndex], lines[b.lineIndex]),
  );
  let left = cap;
  const kept: LineOffer[] = [];
  for (const offer of ranked) {
    const units = Math.min(offer.units, left);
    if (units > 0) kept.push({ ...offer, units });
    left -= units;
  }
  return kept;
}

/**
 * The line's units grouped by what they pay. Each offer covers the line's first units, so the units between two
 * offers' unit counts share the same offers; neighbouring groups that end up with the same promotions are merged.
 */
function unitGroups(line: PricingLine, offers: readonly LineOffer[]): { quantity: number; discount: UnitPromotions }[] {
  const ends = [...new Set([...offers.map((offer) => offer.units), line.quantity])].sort((a, b) => a - b);
  const groups: { quantity: number; discount: UnitPromotions }[] = [];
  let start = 0;
  for (const end of ends) {
    const discount = stackedUnitOffers(
      line.unitListPrice,
      offers.filter((offer) => offer.units >= end),
    );
    const previous = groups[groups.length - 1];
    if (previous && samePromotions(previous.discount, discount)) previous.quantity += end - start;
    else groups.push({ quantity: end - start, discount });
    start = end;
  }
  return groups;
}

function samePromotions(a: UnitPromotions, b: UnitPromotions): boolean {
  return (
    a.applied.length === b.applied.length &&
    a.applied.every(
      (each, index) =>
        each.promotion === b.applied[index].promotion && each.unitSaving.equals(b.applied[index].unitSaving),
    )
  );
}

/**
 * The item promotions on one unit priced `unitListPrice`: per stacking group the candidate saving the most at the list
 * price, then the groups' winners one after the other, lowest priority number first (then the oldest), each on what is
 * left of the price, so the unit never goes below zero.
 */
export function stackedUnitPromotions(unitListPrice: Decimal, candidates: readonly PricingPromotion[]): UnitPromotions {
  return stackedUnitOffers(
    unitListPrice,
    candidates.map((promotion) => ({ promotion, rule: ownRule(promotion) })),
  );
}

function stackedUnitOffers(unitListPrice: Decimal, offers: readonly UnitOffer[]): UnitPromotions {
  const ruleOf = new Map(offers.map((offer) => [offer.promotion, offer.rule]));
  const rule = (promotion: PricingPromotion) => ruleOf.get(promotion)!;
  let left = unitListPrice;
  const applied: UnitPromotion[] = [];
  for (const promotion of groupWinners([...ruleOf.keys()], (each) => unitSaving(unitListPrice, rule(each)))) {
    const saving = unitSaving(left, rule(promotion));
    if (!saving.gt(0)) continue;
    applied.push({ unitSaving: saving, promotion });
    left = left.sub(saving);
  }
  return { unitDiscount: unitListPrice.sub(left), applied };
}

/**
 * The item promotions a product page shows `customer` on one unit of the variant: the automatic ones (no coupon, not
 * first-order only: a page cannot tell a first order) that are live with uses and units left and open to the customer,
 * combined as at checkout (an exclusive one that saves anything alone, otherwise the stacked groups). Minimum spend
 * and quantity are not checked (there is no cart).
 */
export function displayUnitPromotions(
  line: Pick<PricingLine, TargetKey | 'unitListPrice'>,
  promotions: readonly PricingPromotion[],
  now: Date,
  customer: PricingCustomer = ANONYMOUS_CUSTOMER,
): UnitPromotions {
  const shown = promotions.filter(
    (promotion) =>
      SIMPLE_TYPES.includes(promotion.type) &&
      !promotion.requiresCoupon &&
      !promotion.firstOrderOnly &&
      isLive(promotion, now) &&
      hasUsesLeft(promotion) &&
      unitsLeft(promotion) > 0 &&
      audienceRejection(promotion, customer) === null &&
      targets(promotion, line),
  );
  const exclusive = best(
    shown.filter((promotion) => promotion.exclusive),
    (promotion) => unitSaving(line.unitListPrice, ownRule(promotion)),
  );
  return stackedUnitPromotions(
    line.unitListPrice,
    exclusive ? [exclusive] : shown.filter((promotion) => !promotion.exclusive),
  );
}

/**
 * The exclusive candidate saving the most on the whole cart on its own (an item one on the units it offers, a cart
 * one on the list-price subtotal, a shipping one on the fee), when one saves anything.
 */
function bestExclusive(
  lines: readonly PricingLine[],
  itemOffers: readonly LineOffer[],
  orderCandidates: readonly PricingPromotion[],
  grossSubtotal: Decimal,
  fee: Decimal,
): PricingPromotion | undefined {
  const aloneSaving = (promotion: PricingPromotion) =>
    isShippingLevel(promotion)
      ? feeSaving(fee, promotion)
      : isCartLevel(promotion)
        ? cartSaving(grossSubtotal, cartRule(promotion, grossSubtotal))
        : itemOffers
            .filter((offer) => offer.promotion === promotion)
            .reduce(
              (sum, offer) => sum.add(unitSaving(lines[offer.lineIndex].unitListPrice, offer.rule).mul(offer.units)),
              new Decimal(0),
            );
  const itemCandidates = [...new Set(itemOffers.map((offer) => offer.promotion))];
  return best(
    [...itemCandidates, ...orderCandidates].filter((promotion) => promotion.exclusive),
    aloneSaving,
  );
}

/** A cart promotion reducing the merchandise (not a free-shipping one). */
function isCartLevel(promotion: PricingPromotion): boolean {
  return promotion.scope === PromotionScope.CART && promotion.type !== PromotionType.FREE_SHIPPING;
}

function isShippingLevel(promotion: PricingPromotion): boolean {
  return promotion.type === PromotionType.FREE_SHIPPING;
}

/** What a free-shipping promotion takes off a fee: all of it (no value) or value, never more than the fee. */
function feeSaving(fee: Decimal, promotion: PricingPromotion): Decimal {
  return promotion.value === null ? fee : Decimal.min(fee, Decimal.max(0, promotion.value));
}

/**
 * Per stacking group the promotion with the largest `saving` (above zero), the groups' winners in the order they
 * apply: lowest priority number first, then the oldest.
 */
function groupWinners(
  candidates: readonly PricingPromotion[],
  saving: (promotion: PricingPromotion) => Decimal,
): PricingPromotion[] {
  const groups = new Map<string, PricingPromotion[]>();
  for (const promotion of candidates) {
    groups.set(promotion.stackingGroup, [...(groups.get(promotion.stackingGroup) ?? []), promotion]);
  }
  return [...groups.values()]
    .map((group) => best(group, saving))
    .filter((winner): winner is PricingPromotion => winner !== undefined)
    .sort(tieOrder);
}

/** The promotion with the largest saving above zero; equal savings go to the lowest priority number, then the oldest. */
function best(
  candidates: readonly PricingPromotion[],
  saving: (promotion: PricingPromotion) => Decimal,
): PricingPromotion | undefined {
  let winner: { promotion: PricingPromotion; saving: Decimal } | undefined;
  for (const promotion of [...candidates].sort(tieOrder)) {
    const amount = saving(promotion);
    if (amount.gt(winner?.saving ?? 0)) winner = { promotion, saving: amount };
  }
  return winner?.promotion;
}

/**
 * What `rule` takes off one unit priced `unitPrice`: a percentage rounded half-up, an amount, or down to a fixed
 * price; never more than the price, never a rise.
 */
function unitSaving(unitPrice: Decimal, rule: Rule): Decimal {
  const raw =
    rule.type === PromotionType.PERCENT
      ? unitPrice.mul(rule.value).div(100)
      : rule.type === PromotionType.AMOUNT_OFF
        ? rule.value
        : unitPrice.sub(rule.value);
  return Decimal.min(unitPrice, Decimal.max(0, roundHalfUp(raw)));
}

/**
 * What a cart rule takes off `subtotal`: a percentage rounded half-up or an amount, never more than it; nothing
 * without a rule (a tiered promotion no tier of which is reached).
 */
function cartSaving(subtotal: Decimal, rule: Rule | null): Decimal {
  if (!rule) return new Decimal(0);
  const raw = rule.type === PromotionType.PERCENT ? subtotal.mul(rule.value).div(100) : rule.value;
  return Decimal.min(subtotal, Decimal.max(0, roundHalfUp(raw)));
}

function tieOrder(a: PricingPromotion, b: PricingPromotion): number {
  return a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id);
}

/** COUPON with its code when the coupon code unlocked the promotion, DISCOUNT otherwise. */
function adjustmentFrom(
  promotion: PricingPromotion,
  saving: Decimal,
  couponCode: PricingCouponCode | undefined,
): QuoteAdjustment {
  const unlocked = promotion.requiresCoupon && couponCode?.promotionId === promotion.id;
  return {
    type: unlocked ? OrderAdjustmentType.COUPON : OrderAdjustmentType.DISCOUNT,
    sourceId: promotion.id,
    code: unlocked ? couponCode.code : null,
    amount: saving.neg(),
  };
}

function assertValidLine(line: PricingLine): void {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new RangeError(
      `Quantity of variant "${line.variantId}" must be a positive whole number, got ${line.quantity}`,
    );
  }
  if (line.unitListPrice.isNegative() || !line.unitListPrice.equals(roundHalfUp(line.unitListPrice))) {
    throw new RangeError(
      `Price of variant "${line.variantId}" must be whole pesewas and not negative, got ${line.unitListPrice.toString()}`,
    );
  }
}

/** Positive rates only, by name then id, so equal rates split a remainder pesewa the same way every time. */
function canonicalTaxRates(taxRates: readonly PricingTaxRate[]): PricingTaxRate[] {
  if (taxRates.some((tax) => tax.rate.isNegative())) throw new RangeError('Tax rates must not be negative');
  return taxRates
    .filter((tax) => tax.rate.gt(0))
    .sort((a, b) => compareStrings(a.name, b.name) || compareStrings(a.id, b.id));
}

function priceLine(
  line: PricingLine,
  cartLineIndex: number,
  quantity: number,
  discount: UnitPromotions,
  taxRates: readonly PricingTaxRate[],
  money: (value: Decimal.Value) => Money,
  couponCode: PricingCouponCode | undefined,
): QuoteLine {
  const unitList = money(line.unitListPrice);
  const unitGross = unitList.subtract(money(discount.unitDiscount));
  const totalRate = taxRates.reduce((sum, tax) => sum.add(tax.rate), new Decimal(0));
  const taxed = line.taxable && totalRate.gt(0);
  // The net is rounded once per unit and the tax is what remains, so net + tax is exactly the price paid.
  const unitNet = taxed ? money(roundHalfUp(unitGross.amount.div(totalRate.add(1)))) : unitGross;
  const unitTax = unitGross.subtract(unitNet);
  const base = unitNet.times(quantity).amount;
  const taxLines = taxed
    ? unitTax
        .times(quantity)
        .allocate(taxRates.map((tax) => tax.rate))
        .map((amount, index) => ({
          taxId: taxRates[index].id,
          name: taxRates[index].name,
          rate: taxRates[index].rate,
          base,
          amount: amount.amount,
        }))
    : [];
  return {
    cartLineIndex,
    variantId: line.variantId,
    productId: line.productId,
    quantity,
    unitListPrice: unitList.amount,
    unitDiscount: discount.unitDiscount,
    unitNet: unitNet.amount,
    unitTax: unitTax.amount,
    lineTotal: unitGross.times(quantity).amount,
    adjustments: discount.applied.map(({ promotion, unitSaving: saving }) =>
      adjustmentFrom(promotion, money(saving).times(quantity).amount, couponCode),
    ),
    taxLines,
  };
}

/**
 * Splits an order-level amount over the quote lines in proportion to what each still costs (`remaining`). Lines are
 * taken in a canonical order (not the cart's), so which line gets a remainder pesewa does not depend on the order the
 * lines came in. The amount is never more than the remaining total, so no line goes below zero.
 */
function allocateToLines(amount: Money, lines: readonly QuoteLine[], remaining: readonly Money[]): Money[] {
  const order = lines.map((_, index) => index).sort((a, b) => compareLines(lines[a], lines[b]));
  const shares = amount.allocate(order.map((index) => remaining[index].amount));
  const byLine = new Array<Money>(remaining.length);
  order.forEach((lineIndex, position) => (byLine[lineIndex] = shares[position]));
  return byLine;
}

type ComparableLine = Pick<QuoteLine, 'variantId' | 'quantity' | 'unitListPrice'> & { unitDiscount?: Decimal };

/** By variant, then quantity, then price, then discount: lines equal in all of them are interchangeable. */
function compareLines(a: ComparableLine, b: ComparableLine): number {
  return (
    compareStrings(a.variantId, b.variantId) ||
    a.quantity - b.quantity ||
    a.unitListPrice.comparedTo(b.unitListPrice) ||
    (a.unitDiscount ?? new Decimal(0)).comparedTo(b.unitDiscount ?? new Decimal(0))
  );
}

function negate(amount: Decimal): Decimal {
  return amount.isZero() ? new Decimal(0) : amount.neg();
}

/** Null (no threshold) first. */
function compareDecimals(a: Decimal | null, b: Decimal | null): number {
  if (a === null || b === null) return (a === null ? 0 : 1) - (b === null ? 0 : 1);
  return a.comparedTo(b);
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
