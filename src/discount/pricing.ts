import { DiscountType, Prisma } from '../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';
import { DiscountCalculation } from './types';

type Money = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export interface CandidateDiscount {
  id: string;
  type: DiscountType | `${DiscountType}`;
  value: Decimal.Value;
  minimumPurchase?: Decimal.Value | null;
}

export interface UnitPrice {
  unitPrice: Money;
  unitDiscount: Money;
  discountedUnitPrice: Money;
  discountId?: string;
}

export interface CartLine {
  productId: string;
  unitPrice: Decimal.Value;
  quantity: number;
}

export interface PricedLine extends UnitPrice {
  productId: string;
  quantity: number;
  lineDiscount: Money;
  lineTotal: Money;
}

export interface PricedCart {
  lines: PricedLine[];
  grossSubtotal: Money;
  discountTotal: Money;
  subtotal: Money;
}

function toCedis(value: Decimal.Value): Money {
  return new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function unitSaving(unitPrice: Money, discount: CandidateDiscount): Money {
  const raw =
    discount.type === DiscountType.PERCENTAGE
      ? unitPrice.mul(discount.value).div(100)
      : new Prisma.Decimal(discount.value);
  return Prisma.Decimal.min(unitPrice, Prisma.Decimal.max(ZERO, toCedis(raw)));
}

/** Applies the discount that saves the most money on one unit; ties keep the earlier candidate. */
export function bestUnitPrice(price: Decimal.Value, discounts: readonly CandidateDiscount[]): UnitPrice {
  const unitPrice = toCedis(price);
  let best: { discount: CandidateDiscount; saving: Money } | undefined;
  for (const discount of discounts) {
    const saving = unitSaving(unitPrice, discount);
    if (saving.gt(best?.saving ?? ZERO)) best = { discount, saving };
  }
  const unitDiscount = best?.saving ?? ZERO;
  return {
    unitPrice,
    unitDiscount,
    discountedUnitPrice: unitPrice.sub(unitDiscount),
    ...(best && { discountId: best.discount.id }),
  };
}

export function toDiscountCalculation(unit: UnitPrice): DiscountCalculation {
  return {
    discountedPrice: unit.discountedUnitPrice.toNumber(),
    discountAmount: unit.unitDiscount.toNumber(),
    ...(unit.discountId && { discountId: unit.discountId }),
  };
}

/**
 * Prices a cart the same way for the cart preview and for checkout. A discount whose minimum purchase exceeds
 * the cart's list-price subtotal is not applied.
 */
export function priceCart(
  lines: readonly CartLine[],
  discountsByProduct: ReadonlyMap<string, readonly CandidateDiscount[]>,
): PricedCart {
  const grossSubtotal = lines.reduce((sum, line) => sum.add(toCedis(line.unitPrice).mul(line.quantity)), ZERO);
  const isEligible = (discount: CandidateDiscount) =>
    discount.minimumPurchase === null ||
    discount.minimumPurchase === undefined ||
    grossSubtotal.gte(discount.minimumPurchase);

  const priced = lines.map((line): PricedLine => {
    const eligible = (discountsByProduct.get(line.productId) ?? []).filter(isEligible);
    const unit = bestUnitPrice(line.unitPrice, eligible);
    return {
      ...unit,
      productId: line.productId,
      quantity: line.quantity,
      lineDiscount: unit.unitDiscount.mul(line.quantity),
      lineTotal: unit.discountedUnitPrice.mul(line.quantity),
    };
  });

  const discountTotal = priced.reduce((sum, line) => sum.add(line.lineDiscount), ZERO);
  return { lines: priced, grossSubtotal, discountTotal, subtotal: grossSubtotal.sub(discountTotal) };
}
