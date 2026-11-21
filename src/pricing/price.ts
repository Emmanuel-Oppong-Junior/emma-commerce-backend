import { Decimal } from '@prisma/client/runtime/client';
import { Currency, DiscountType, OrderAdjustmentType } from '../generated/prisma/client';
import { Money, roundHalfUp } from '../commons/money/money';
import { quoteHash } from './quote-hash';

/** The pricing rules `price` implements; stored on every order it priced (legacy orders have 0). */
export const PRICING_VERSION = 1;

export interface PricingLine {
  variantId: string;
  productId: string;
  categoryId: string | null;
  quantity: number;
  /** One unit, in whole pesewas. It includes the active taxes when `taxable`. */
  unitListPrice: Decimal;
  /** The price had the active tax rates added to it (a taxable product's variant with a basePrice). */
  taxable: boolean;
}

export interface PricingDiscount {
  id: string;
  type: DiscountType;
  value: Decimal;
  minimumPurchase: Decimal | null;
  isActive: boolean;
  startDate: Date;
  endDate: Date;
  createdAt: Date;
  variantIds: readonly string[];
  productIds: readonly string[];
  categoryIds: readonly string[];
}

export interface PricingCoupon {
  id: string;
  code: string;
  discountType: DiscountType;
  value: Decimal;
  minimumOrderAmount: Decimal | null;
  isActive: boolean;
  expiresAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  /** The customer already has a use of this coupon recorded. */
  usedByCustomer: boolean;
}

export interface PricingTaxRate {
  id: string;
  name: string;
  rate: Decimal;
}

/** What is being bought. */
export interface PricingCart {
  lines: readonly PricingLine[];
  coupon?: PricingCoupon;
  /** The fee of the chosen fulfilment: the delivery zone's fee, or 0 for pickup. */
  shippingFee: Decimal;
}

/** Everything else the price depends on, read at one moment. */
export interface PricingContext {
  currency: Currency;
  now: Date;
  /** Candidate discounts; the engine decides which apply to which line. */
  discounts: readonly PricingDiscount[];
  /** The active taxes, whose rates taxable prices include. */
  taxRates: readonly PricingTaxRate[];
}

/** A reduction with its source; amounts are negative. */
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
  /** The item discount taken off the line (already in unitDiscount). */
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
  /** The coupon, if it takes anything off. */
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

/** The coupon cannot be used on this cart; the message says why and is safe to show the customer. */
export class CouponNotApplicableError extends Error {}

/**
 * Prices a cart (ADR-0005). Pure: the same cart and context always give the same quote and hash, whatever order the
 * lines, discounts or taxes come in. The rules:
 * - each line gets the applicable discount (its variant's, its product's or its category's, active and in date, and
 *   whose minimum purchase the list-price subtotal reaches) that saves the most money on one unit, capped at the price;
 *   equal savings go to the oldest discount;
 * - the coupon comes off the discounted subtotal (its minimum order amount is checked against it), never more than
 *   it, and is allocated to the lines;
 * - a taxable price includes the active taxes: per unit, the net is the discounted price over (1 + Σ rates), rounded
 *   half-up, the tax is the rest, split over the rates by largest remainder; the coupon and shipping are untaxed.
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

  const grossSubtotal = cart.lines.reduce((sum, line) => sum.add(money(line.unitListPrice).times(line.quantity)), zero);
  const lines = cart.lines.map((line) => {
    const candidates = discountsApplyingTo(line, context.discounts, context.now).filter(
      (discount) => discount.minimumPurchase === null || grossSubtotal.amount.gte(discount.minimumPurchase),
    );
    return priceLine(line, bestUnitDiscount(line.unitListPrice, candidates), taxRates, money);
  });

  const merchandise = lines.reduce((sum, line) => sum.add(money(line.lineTotal)), zero);
  const adjustments: QuoteOrderAdjustment[] = [];
  if (cart.coupon) {
    const amount = couponAmount(cart.coupon, merchandise.amount, context.now);
    if (amount.gt(0)) {
      adjustments.push({
        type: OrderAdjustmentType.COUPON,
        sourceId: cart.coupon.id,
        code: cart.coupon.code,
        amount: amount.neg(),
        allocations: allocateToLines(money(amount), cart.lines, lines).map((share) => negate(share.amount)),
      });
    }
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

/** The discounts that target the line (its variant, product or category) and are active at `now`. */
export function discountsApplyingTo(
  line: Pick<PricingLine, 'variantId' | 'productId' | 'categoryId'>,
  discounts: readonly PricingDiscount[],
  now: Date,
): PricingDiscount[] {
  return discounts.filter(
    (discount) =>
      discount.isActive &&
      discount.startDate <= now &&
      discount.endDate >= now &&
      (discount.variantIds.includes(line.variantId) ||
        discount.productIds.includes(line.productId) ||
        (line.categoryId !== null && discount.categoryIds.includes(line.categoryId))),
  );
}

export interface UnitDiscount {
  unitDiscount: Decimal;
  /** The discount taken, when one saves anything. */
  discountId?: string;
}

/** The candidate that saves the most money on one unit, capped at the price; equal savings go to the oldest. */
export function bestUnitDiscount(unitListPrice: Decimal, candidates: readonly PricingDiscount[]): UnitDiscount {
  let best: { discount: PricingDiscount; saving: Decimal } | undefined;
  for (const discount of [...candidates].sort(oldestFirst)) {
    const saving = unitSaving(unitListPrice, discount);
    if (saving.gt(best?.saving ?? 0)) best = { discount, saving };
  }
  return best ? { unitDiscount: best.saving, discountId: best.discount.id } : { unitDiscount: new Decimal(0) };
}

function unitSaving(unitListPrice: Decimal, discount: PricingDiscount): Decimal {
  const raw = discount.type === DiscountType.PERCENTAGE ? unitListPrice.mul(discount.value).div(100) : discount.value;
  return Decimal.min(unitListPrice, Decimal.max(0, roundHalfUp(raw)));
}

function oldestFirst(a: PricingDiscount, b: PricingDiscount): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareStrings(a.id, b.id);
}

/**
 * Why the coupon cannot be used on a cart whose discounted subtotal is `subtotal`, or null when it can.
 */
export function couponRejection(coupon: PricingCoupon, subtotal: Decimal, now: Date): string | null {
  if (!coupon.isActive) return 'This coupon is no longer active';
  if (coupon.expiresAt && coupon.expiresAt < now) return 'This coupon has expired';
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    return 'This coupon has reached its usage limit';
  }
  if (coupon.minimumOrderAmount && subtotal.lt(coupon.minimumOrderAmount)) {
    return `Order total must be at least ${coupon.minimumOrderAmount.toString()} to use this coupon`;
  }
  if (coupon.usedByCustomer) return 'You have already used this coupon';
  return null;
}

/**
 * What the coupon takes off a discounted subtotal: a percentage of it rounded half-up, or a flat amount, never more
 * than the subtotal. Throws CouponNotApplicableError when the coupon cannot be used.
 */
export function couponAmount(coupon: PricingCoupon, subtotal: Decimal, now: Date): Decimal {
  const rejection = couponRejection(coupon, subtotal, now);
  if (rejection) throw new CouponNotApplicableError(rejection);
  const raw = coupon.discountType === DiscountType.PERCENTAGE ? subtotal.mul(coupon.value).div(100) : coupon.value;
  return Decimal.min(subtotal, Decimal.max(0, roundHalfUp(raw)));
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
  discount: UnitDiscount,
  taxRates: readonly PricingTaxRate[],
  money: (value: Decimal.Value) => Money,
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
      discount.discountId && lineDiscount.isPositive()
        ? [
            {
              type: OrderAdjustmentType.DISCOUNT,
              sourceId: discount.discountId,
              code: null,
              amount: lineDiscount.amount.neg(),
            },
          ]
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
