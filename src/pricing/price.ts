import { Decimal } from '@prisma/client/runtime/client';
import { Currency, OrderAdjustmentType, PromotionScope, PromotionType } from '../generated/prisma/client';
import { Money, roundHalfUp } from '../commons/money/money';
import { quoteHash } from './quote-hash';

/** The pricing rules `price` implements; stored on every order it priced (legacy orders have 0). */
export const PRICING_VERSION = 1;

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
  value: Decimal;
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
  perCustomerLimit: number | null;
  createdAt: Date;
  /** What it targets, of its scope's kind: variant ids (SKU), product, category or brand ids; none for CART. */
  targetIds: readonly string[];
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
}

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

export interface QuoteLine {
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
 *              = subtotal - discountTotal + shippingTotal.
 */
export interface Quote {
  currency: Currency;
  pricingVersion: number;
  /** In the order of the cart's lines. */
  lines: QuoteLine[];
  /** The cart promotions that take something off. */
  adjustments: QuoteOrderAdjustment[];
  /** Σ unitListPrice × quantity. */
  subtotal: Decimal;
  /** Item discounts plus order adjustments, as a positive amount. */
  discountTotal: Decimal;
  taxTotal: Decimal;
  shippingTotal: Decimal;
  /** The amount to charge. */
  grandTotal: Decimal;
  /** SHA-256 of every value that determines the charge (see quote-hash.ts). */
  quoteHash: string;
}

/** The coupon code cannot be used on this cart; the message says why and is safe to show the customer. */
export class CouponNotApplicableError extends Error {}

/**
 * Prices a cart (ADR-0005). Pure: the same cart and context always give the same quote and hash, whatever order the
 * lines, promotions or taxes come in. A promotion is a candidate when it is active, in its schedule, within its usage
 * limits for the customer, and unlocked by the coupon code if it requires one. The rules:
 * - item level: each line gets the candidate item promotion (on its variant, product, category or brand) that saves
 *   the most money on one unit, capped at the price, whose minimum spend the list-price subtotal reaches and whose
 *   minimum quantity the targeted units in the cart reach; equal savings go to the oldest promotion;
 * - cart level: the candidate cart promotion saving the most comes off the subtotal after item promotions (its
 *   minimum spend is checked against that subtotal), never more than it, and is allocated to the lines;
 * - a taxable price includes the active taxes: per unit, the net is the discounted price over (1 + Σ rates), rounded
 *   half-up, the tax is the rest, split over the rates by largest remainder; cart promotions and shipping are untaxed.
 * A coupon code whose promotion cannot be used throws CouponNotApplicableError.
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
  const itemCandidates = candidates.filter(
    (promotion) =>
      promotion.scope !== PromotionScope.CART &&
      reachesMinimums(promotion, grossSubtotal.amount, targetedQuantity(promotion, cart.lines)),
  );
  if (couponPromotion && couponPromotion.scope !== PromotionScope.CART) {
    assertItemCouponApplies(couponPromotion, cart.lines, grossSubtotal.amount);
  }
  const lines = cart.lines.map((line) =>
    priceLine(
      line,
      bestUnitPromotion(
        line.unitListPrice,
        itemCandidates.filter((promotion) => targets(promotion, line)),
      ),
      taxRates,
      money,
      cart.couponCode,
    ),
  );

  const merchandise = lines.reduce((sum, line) => sum.add(money(line.lineTotal)), zero);
  const cartQuantity = cart.lines.reduce((sum, line) => sum + line.quantity, 0);
  if (couponPromotion?.scope === PromotionScope.CART) {
    const rejection = minimumsRejection(couponPromotion, merchandise.amount, cartQuantity);
    if (rejection) throw new CouponNotApplicableError(rejection);
  }
  const cartCandidates = candidates.filter(
    (promotion) =>
      promotion.scope === PromotionScope.CART && reachesMinimums(promotion, merchandise.amount, cartQuantity),
  );
  const adjustments: QuoteOrderAdjustment[] = [];
  const best = bestCartPromotion(merchandise.amount, cartCandidates);
  if (best) {
    adjustments.push({
      ...adjustmentFrom(best.promotion, best.saving, cart.couponCode),
      allocations: allocateToLines(money(best.saving), cart.lines, lines).map((share) => negate(share.amount)),
    });
  }

  const shipping = money(cart.shippingFee);
  if (shipping.isNegative() || !shipping.equals(shipping.roundHalfUp())) {
    throw new RangeError(`Shipping must be whole pesewas and not negative, got ${shipping.amount.toString()}`);
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
    subtotal: grossSubtotal.amount,
    discountTotal: discountTotal.amount,
    taxTotal: taxTotal.amount,
    shippingTotal: shipping.amount,
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

function customerHasUsesLeft(promotion: PricingPromotion, customer: PricingCustomer): boolean {
  return promotion.perCustomerLimit === null || (customer.redemptions[promotion.id] ?? 0) < promotion.perCustomerLimit;
}

function isCandidate(
  promotion: PricingPromotion,
  couponCode: PricingCouponCode | undefined,
  context: PricingContext,
): boolean {
  return (
    isLive(promotion, context.now) &&
    hasUsesLeft(promotion) &&
    customerHasUsesLeft(promotion, context.customer) &&
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
 * promotion must be active and in date, with uses left overall and for the customer.
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
  if (!customerHasUsesLeft(promotion, customer)) return 'You have already used this coupon';
  return null;
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
  unitDiscount: Decimal;
  /** The promotion taken, when one saves anything. */
  promotion?: PricingPromotion;
}

/** The candidate that saves the most money on one unit, capped at the price; equal savings go to the oldest. */
export function bestUnitPromotion(unitListPrice: Decimal, candidates: readonly PricingPromotion[]): UnitPromotion {
  let best: { promotion: PricingPromotion; saving: Decimal } | undefined;
  for (const promotion of [...candidates].sort(oldestFirst)) {
    const saving = unitSaving(unitListPrice, promotion);
    if (saving.gt(best?.saving ?? 0)) best = { promotion, saving };
  }
  return best ? { unitDiscount: best.saving, promotion: best.promotion } : { unitDiscount: new Decimal(0) };
}

/**
 * The item promotion a product page shows on one unit of the variant: the best automatic (no coupon) one that is live
 * with uses left. Minimum spend and quantity are not checked (there is no cart).
 */
export function displayUnitPromotion(
  line: Pick<PricingLine, TargetKey | 'unitListPrice'>,
  promotions: readonly PricingPromotion[],
  now: Date,
): UnitPromotion {
  return bestUnitPromotion(
    line.unitListPrice,
    promotions.filter(
      (promotion) =>
        !promotion.requiresCoupon && isLive(promotion, now) && hasUsesLeft(promotion) && targets(promotion, line),
    ),
  );
}

/**
 * What the promotion takes off one unit priced `unitPrice`: a percentage rounded half-up, an amount, or down to a
 * fixed price; never more than the price, never a rise.
 */
function unitSaving(unitPrice: Decimal, promotion: PricingPromotion): Decimal {
  const raw =
    promotion.type === PromotionType.PERCENT
      ? unitPrice.mul(promotion.value).div(100)
      : promotion.type === PromotionType.AMOUNT_OFF
        ? promotion.value
        : unitPrice.sub(promotion.value);
  return Decimal.min(unitPrice, Decimal.max(0, roundHalfUp(raw)));
}

/** What a cart promotion takes off `subtotal`: a percentage rounded half-up or an amount, never more than it. */
function cartSaving(subtotal: Decimal, promotion: PricingPromotion): Decimal {
  const raw = promotion.type === PromotionType.PERCENT ? subtotal.mul(promotion.value).div(100) : promotion.value;
  return Decimal.min(subtotal, Decimal.max(0, roundHalfUp(raw)));
}

function bestCartPromotion(
  subtotal: Decimal,
  candidates: readonly PricingPromotion[],
): { promotion: PricingPromotion; saving: Decimal } | undefined {
  let best: { promotion: PricingPromotion; saving: Decimal } | undefined;
  for (const promotion of [...candidates].sort(oldestFirst)) {
    const saving = cartSaving(subtotal, promotion);
    if (saving.gt(best?.saving ?? 0)) best = { promotion, saving };
  }
  return best;
}

function oldestFirst(a: PricingPromotion, b: PricingPromotion): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id);
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
  discount: UnitPromotion,
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
  const base = unitNet.times(line.quantity).amount;
  const taxLines = taxed
    ? unitTax
        .times(line.quantity)
        .allocate(taxRates.map((tax) => tax.rate))
        .map((amount, index) => ({
          taxId: taxRates[index].id,
          name: taxRates[index].name,
          rate: taxRates[index].rate,
          base,
          amount: amount.amount,
        }))
    : [];
  const lineDiscount = money(discount.unitDiscount).times(line.quantity);

  return {
    variantId: line.variantId,
    productId: line.productId,
    quantity: line.quantity,
    unitListPrice: unitList.amount,
    unitDiscount: discount.unitDiscount,
    unitNet: unitNet.amount,
    unitTax: unitTax.amount,
    lineTotal: unitGross.times(line.quantity).amount,
    adjustments:
      discount.promotion && lineDiscount.isPositive()
        ? [adjustmentFrom(discount.promotion, lineDiscount.amount, couponCode)]
        : [],
    taxLines,
  };
}

/**
 * Splits an order-level amount over the lines in proportion to their totals. Lines are taken in a canonical order
 * (not the cart's), so which line gets a remainder pesewa does not depend on the order the lines came in.
 */
function allocateToLines(amount: Money, input: readonly PricingLine[], lines: readonly QuoteLine[]): Money[] {
  const order = canonicalLineOrder(input);
  const shares = amount.allocate(order.map((index) => lines[index].lineTotal));
  const byLine = new Array<Money>(lines.length);
  order.forEach((lineIndex, position) => (byLine[lineIndex] = shares[position]));
  return byLine;
}

/** Line indexes sorted by variant, then quantity, then price: identical lines are interchangeable. */
export function canonicalLineOrder(lines: readonly Pick<PricingLine, 'variantId' | 'quantity' | 'unitListPrice'>[]) {
  return lines
    .map((_, index) => index)
    .sort(
      (a, b) =>
        compareStrings(lines[a].variantId, lines[b].variantId) ||
        lines[a].quantity - lines[b].quantity ||
        lines[a].unitListPrice.comparedTo(lines[b].unitListPrice),
    );
}

function negate(amount: Decimal): Decimal {
  return amount.isZero() ? new Decimal(0) : amount.neg();
}

function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
