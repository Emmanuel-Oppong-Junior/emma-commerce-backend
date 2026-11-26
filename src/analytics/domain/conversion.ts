const RATIO_DECIMAL_PLACES = 4;

export interface FunnelCounts {
  cartsStarted: number;
  checkoutQuotes: number;
  ordersPlaced: number;
  paidOrders: number;
}

export interface Funnel extends FunnelCounts {
  /** checkoutQuotes / cartsStarted */
  quoteRate: number | null;
  /** ordersPlaced / checkoutQuotes */
  placementRate: number | null;
  /** paidOrders / ordersPlaced */
  paymentRate: number | null;
  /** paidOrders / cartsStarted */
  conversionRate: number | null;
}

/**
 * The checkout funnel of a period. Each step is counted on its own day (a cart started yesterday and paid today counts
 * in both days), so a ratio over a short period can exceed 1; null when the step before counted nothing.
 */
export function funnel(days: readonly FunnelCounts[]): Funnel {
  const sum = (key: keyof FunnelCounts) => days.reduce((total, day) => total + day[key], 0);
  const counts: FunnelCounts = {
    cartsStarted: sum('cartsStarted'),
    checkoutQuotes: sum('checkoutQuotes'),
    ordersPlaced: sum('ordersPlaced'),
    paidOrders: sum('paidOrders'),
  };
  return {
    ...counts,
    quoteRate: ratio(counts.checkoutQuotes, counts.cartsStarted),
    placementRate: ratio(counts.ordersPlaced, counts.checkoutQuotes),
    paymentRate: ratio(counts.paidOrders, counts.ordersPlaced),
    conversionRate: ratio(counts.paidOrders, counts.cartsStarted),
  };
}

function ratio(part: number, whole: number): number | null {
  if (whole === 0) return null;
  const scale = 10 ** RATIO_DECIMAL_PLACES;
  return Math.round((part / whole) * scale) / scale;
}
