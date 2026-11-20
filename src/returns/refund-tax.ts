import { Prisma } from '../generated/prisma/client';
import { roundHalfUp } from '../commons/money/money';

/** What an order stored about its tax when it was placed (P1-O.1). */
export interface OrderTaxSnapshot {
  pricingVersion: number;
  grandTotal: Prisma.Decimal;
  /** Amounts of every OrderLineTax row of the order. */
  taxLineAmounts: Prisma.Decimal[];
  /** taxAmount of the refunds already recorded against the order (FAILED ones excluded). */
  refundedTax: Prisma.Decimal[];
}

const sum = (values: Prisma.Decimal[]) => values.reduce((total, value) => total.add(value), new Prisma.Decimal(0));

/**
 * The tax included in a refund of `refundAmount`: the order's stored tax in proportion to the share of the grand
 * total refunded, half-up to the pesewa and never more than the stored tax not yet refunded. Read from the stored
 * tax lines only, never recomputed from today's rates; null for an order placed before tax was recorded.
 */
export function refundTax(refundAmount: Prisma.Decimal, order: OrderTaxSnapshot): Prisma.Decimal | null {
  if (order.pricingVersion === 0) return null;
  const taxTotal = sum(order.taxLineAmounts);
  if (taxTotal.isZero() || order.grandTotal.isZero()) return new Prisma.Decimal(0);
  const share = roundHalfUp(taxTotal.mul(refundAmount).div(order.grandTotal));
  const remaining = Prisma.Decimal.max(0, taxTotal.sub(sum(order.refundedTax)));
  return Prisma.Decimal.min(share, remaining);
}
