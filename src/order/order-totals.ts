import { Decimal } from '@prisma/client/runtime/client';
import { Currency, OrderAdjustmentType } from '../generated/prisma/client';
import { Money, roundHalfUp } from '../commons/money/money';

/** Orders snapshotted by `snapshotOrder`; legacy orders have pricingVersion 0. */
export const PRICING_VERSION = 1;

export interface TaxRateSnapshot {
  taxId: string;
  name: string;
  rate: Decimal;
}

/** A cart line as the existing pricing (priceCart) priced it. Prices include tax when `taxable`. */
export interface PricedOrderLine {
  productId: string;
  variantId: string;
  productName: string;
  sku: string;
  optionValues: unknown;
  quantity: number;
  unitListPrice: Decimal;
  unitDiscount: Decimal;
  discountId?: string;
  /**
   * The line's price had the active tax rates added to its base price (a taxable product's variant with a
   * basePrice). Any other price is taken as it is, with no tax in it.
   */
  taxable: boolean;
}

export interface AppliedCoupon {
  couponId: string;
  code: string;
  amount: Decimal;
}

export interface AdjustmentSnapshot {
  type: OrderAdjustmentType;
  sourceId: string | null;
  code: string | null;
  /** Signed: reductions are negative. */
  amount: Decimal;
}

export interface LineTaxSnapshot {
  taxId: string;
  name: string;
  rate: Decimal;
  base: Decimal;
  amount: Decimal;
}

export interface OrderLineSnapshot extends PricedOrderLine {
  unitNet: Decimal;
  unitTax: Decimal;
  lineTotal: Decimal;
  taxLines: LineTaxSnapshot[];
  /** The line's product discount as a DISCOUNT adjustment (already reflected in unitDiscount). */
  adjustments: AdjustmentSnapshot[];
}

export interface OrderSnapshot {
  currency: Currency;
  pricingVersion: number;
  lines: OrderLineSnapshot[];
  /** Order-level adjustments (the coupon). */
  adjustments: AdjustmentSnapshot[];
  subtotal: Decimal;
  discountTotal: Decimal;
  taxTotal: Decimal;
  shippingTotal: Decimal;
  grandTotal: Decimal;
}

export interface OrderSnapshotInput {
  currency: Currency;
  lines: readonly PricedOrderLine[];
  taxes: readonly TaxRateSnapshot[];
  shipping: Decimal;
  coupon?: AppliedCoupon;
}

/**
 * Snapshots what the existing pricing charges for an order: per line its tax-free net and included tax (split over
 * the active taxes in proportion to their rates), the product discounts and coupon as adjustments, and the totals.
 * It never changes the amount charged: grandTotal is the lines after discounts, minus the coupon, plus shipping, as
 * checkout computed it before. Every amount is exact to the pesewa and the parts add up:
 *   grandTotal = Σ unitNet × quantity + Σ order adjustments + taxTotal + shippingTotal
 *              = subtotal - discountTotal + shippingTotal
 */
export function snapshotOrder(input: OrderSnapshotInput): OrderSnapshot {
  const money = (value: Decimal.Value) => Money.of(value, input.currency);
  const totalRate = input.taxes.reduce((sum, tax) => sum.add(tax.rate), new Decimal(0));
  if (input.taxes.some((tax) => tax.rate.isNegative())) throw new RangeError('Tax rates must not be negative');

  const lines = input.lines.map((line) => snapshotLine(line, input.taxes, totalRate, money));
  const linesTotal = lines.reduce((sum, line) => sum.add(money(line.lineTotal)), Money.zero(input.currency));
  const shipping = money(roundHalfUp(input.shipping));
  if (shipping.isNegative()) throw new RangeError(`Shipping must not be negative, got ${shipping.toString()}`);

  const adjustments: AdjustmentSnapshot[] = [];
  if (input.coupon) {
    // A coupon never takes the order below zero (checkout clamped the total the same way).
    const applied = Money.min(money(roundHalfUp(input.coupon.amount)), linesTotal.add(shipping));
    if (applied.isNegative()) throw new RangeError(`Coupon amount must not be negative, got ${applied.toString()}`);
    if (applied.isPositive()) {
      adjustments.push({
        type: OrderAdjustmentType.COUPON,
        sourceId: input.coupon.couponId,
        code: input.coupon.code,
        amount: applied.amount.neg(),
      });
    }
  }

  const sum = (values: Decimal[]) => values.reduce((total, value) => total.add(value), new Decimal(0));
  const subtotal = sum(lines.map((line) => line.unitListPrice.mul(line.quantity)));
  const allAdjustments = [...lines.flatMap((line) => line.adjustments), ...adjustments];
  const discountTotal = sum(allAdjustments.map((adjustment) => adjustment.amount)).neg();
  const taxTotal = sum(lines.map((line) => line.unitTax.mul(line.quantity)));
  const grandTotal = subtotal.sub(discountTotal).add(shipping.amount);

  return {
    currency: input.currency,
    pricingVersion: PRICING_VERSION,
    lines,
    adjustments,
    subtotal,
    discountTotal: discountTotal.isZero() ? new Decimal(0) : discountTotal,
    taxTotal,
    shippingTotal: shipping.amount,
    grandTotal,
  };
}

function snapshotLine(
  line: PricedOrderLine,
  taxes: readonly TaxRateSnapshot[],
  totalRate: Decimal,
  money: (value: Decimal.Value) => Money,
): OrderLineSnapshot {
  if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
    throw new RangeError(`Line quantity must be a positive whole number, got ${line.quantity}`);
  }
  const unitList = money(line.unitListPrice);
  const unitDiscount = money(line.unitDiscount);
  if (!unitList.equals(unitList.roundHalfUp()) || !unitDiscount.equals(unitDiscount.roundHalfUp())) {
    throw new RangeError(`Line prices of "${line.sku}" must be whole pesewas`);
  }
  if (unitDiscount.isNegative() || unitDiscount.greaterThan(unitList)) {
    throw new RangeError(`Discount of "${line.sku}" must be between 0 and its list price`);
  }
  const unitGross = unitList.subtract(unitDiscount);
  const taxed = line.taxable && totalRate.gt(0);
  // The tax-free net is rounded once per unit and the tax is what remains, so net + tax is exactly the price paid.
  const unitNet = taxed ? money(roundHalfUp(unitGross.amount.div(totalRate.add(1)))) : unitGross;
  const unitTax = unitGross.subtract(unitNet);
  const lineTax = unitTax.times(line.quantity);
  const base = unitNet.times(line.quantity).amount;

  const positiveTaxes = taxes.filter((tax) => tax.rate.gt(0));
  const taxLines: LineTaxSnapshot[] = taxed
    ? lineTax.allocate(positiveTaxes.map((tax) => tax.rate)).map((amount, index) => ({
        taxId: positiveTaxes[index].taxId,
        name: positiveTaxes[index].name,
        rate: positiveTaxes[index].rate,
        base,
        amount: amount.amount,
      }))
    : [];
  const adjustments: AdjustmentSnapshot[] = unitDiscount.isPositive()
    ? [
        {
          type: OrderAdjustmentType.DISCOUNT,
          sourceId: line.discountId ?? null,
          code: null,
          amount: unitDiscount.times(line.quantity).amount.neg(),
        },
      ]
    : [];

  return {
    ...line,
    unitListPrice: unitList.amount,
    unitDiscount: unitDiscount.amount,
    unitNet: unitNet.amount,
    unitTax: unitTax.amount,
    lineTotal: unitGross.times(line.quantity).amount,
    taxLines,
    adjustments,
  };
}
