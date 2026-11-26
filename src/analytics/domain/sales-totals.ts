import { Decimal } from '@prisma/client/runtime/client';
import { roundHalfUp } from '../../commons/money/money';

/** One day of AnalyticsDailySales. */
export interface DailySales {
  day: Date;
  paidOrders: number;
  unitsSold: number;
  grossRevenue: Decimal;
  itemSales: Decimal;
  itemDiscounts: Decimal;
  orderDiscounts: Decimal;
  loyaltyDiscounts: Decimal;
  shipping: Decimal;
  shippingDiscounts: Decimal;
  tax: Decimal;
  refundCount: number;
  refunds: Decimal;
  refundedShipping: Decimal;
  refundedTax: Decimal;
  unallocatedRefunds: Decimal;
  ordersPlaced: number;
  cartsStarted: number;
  checkoutQuotes: number;
}

const COUNTS = ['paidOrders', 'unitsSold', 'refundCount'] as const;
const AMOUNTS = [
  'grossRevenue',
  'itemSales',
  'itemDiscounts',
  'orderDiscounts',
  'loyaltyDiscounts',
  'shipping',
  'shippingDiscounts',
  'tax',
  'refunds',
  'refundedShipping',
  'refundedTax',
] as const;

export type SalesTotals = Pick<DailySales, (typeof COUNTS)[number] | (typeof AMOUNTS)[number]> & {
  /** grossRevenue - refunds */
  netRevenue: Decimal;
  /** netRevenue / paidOrders, half-up to the pesewa; 0 without paid orders */
  averageOrderValue: Decimal;
};

/** Adds up days of sales: revenue is recognised when paid, refunds when processed, so net may be negative. */
export function salesTotals(days: readonly DailySales[]): SalesTotals {
  const counts = Object.fromEntries(COUNTS.map((key) => [key, days.reduce((sum, day) => sum + day[key], 0)])) as Record<
    (typeof COUNTS)[number],
    number
  >;
  const amounts = Object.fromEntries(
    AMOUNTS.map((key) => [key, days.reduce((sum, day) => sum.add(day[key]), new Decimal(0))]),
  ) as Record<(typeof AMOUNTS)[number], Decimal>;
  const netRevenue = amounts.grossRevenue.sub(amounts.refunds);
  return {
    ...counts,
    ...amounts,
    netRevenue,
    averageOrderValue: averageOrderValue(netRevenue, counts.paidOrders),
  };
}

export function averageOrderValue(netRevenue: Decimal, paidOrders: number): Decimal {
  return paidOrders === 0 ? new Decimal(0) : roundHalfUp(netRevenue.div(paidOrders));
}
