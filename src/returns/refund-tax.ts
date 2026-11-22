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

/** Units of one order line being refunded, with what the line stored about its tax. */
export interface LineTaxPart {
  /** The line's ordered quantity. */
  lineQuantity: number;
  /** Amounts of the line's OrderLineTax rows (its tax for every unit). */
  taxLineAmounts: Prisma.Decimal[];
  /** Units of the line refunded before this refund. */
  refundedQuantity: number;
  quantity: number;
}

/** The parts of one refund. The shipping fee is untaxed, so it adds no tax. */
export interface RefundTaxParts {
  lines: LineTaxPart[];
  /** A free amount, not tied to lines or shipping. */
  amount: Prisma.Decimal;
}

const sum = (values: Prisma.Decimal[]) => values.reduce((total, value) => total.add(value), new Prisma.Decimal(0));

/** The line's stored tax for its first `units` units; telescopes, so all units together give exactly its stored tax. */
function lineTaxFor(line: LineTaxPart, units: number): Prisma.Decimal {
  return roundHalfUp(sum(line.taxLineAmounts).mul(units).div(line.lineQuantity));
}

/**
 * The tax included in a refund, read from the stored tax lines only, never recomputed from today's rates: each
 * refunded line unit takes its line's stored tax per unit, a free amount takes the order's stored tax in proportion to
 * its share of the grand total (half-up to the pesewa), and the total never exceeds the stored tax not yet refunded.
 * Null for an order placed before tax was recorded.
 */
export function refundPartsTax(parts: RefundTaxParts, order: OrderTaxSnapshot): Prisma.Decimal | null {
  if (order.pricingVersion === 0) return null;
  const taxTotal = sum(order.taxLineAmounts);
  if (taxTotal.isZero()) return new Prisma.Decimal(0);
  const linesTax = sum(
    parts.lines.map((line) =>
      lineTaxFor(line, line.refundedQuantity + line.quantity).sub(lineTaxFor(line, line.refundedQuantity)),
    ),
  );
  const amountTax = order.grandTotal.isZero()
    ? new Prisma.Decimal(0)
    : roundHalfUp(taxTotal.mul(parts.amount).div(order.grandTotal));
  const remaining = Prisma.Decimal.max(0, taxTotal.sub(sum(order.refundedTax)));
  return Prisma.Decimal.min(linesTax.add(amountTax), remaining);
}

/** The tax included in a refund of `refundAmount` that is not tied to lines (a return or an auto-refund). */
export function refundTax(refundAmount: Prisma.Decimal, order: OrderTaxSnapshot): Prisma.Decimal | null {
  return refundPartsTax({ lines: [], amount: refundAmount }, order);
}
