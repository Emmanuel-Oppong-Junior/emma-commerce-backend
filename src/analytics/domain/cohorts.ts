import { Decimal } from '@prisma/client/runtime/client';

/** Most cohorts (first-order months) in one report, and most months followed after the first. */
export const MAX_COHORTS = 24;
export const MAX_COHORT_MONTHS = 24;

const MONTH_TEXT = /^(\d{4})-(0[1-9]|1[0-2])$/;
const RATE_DECIMAL_PLACES = 4;

/** Customers whose first paid order fell in the month, and how many of them paid for another order since. */
export interface CohortSize {
  month: Date;
  customers: number;
  repeatCustomers: number;
}

/** What a cohort did `offset` months after its first month (0 = that month). */
export interface CohortCell {
  month: Date;
  offset: number;
  activeCustomers: number;
  orders: number;
  /** Paid order totals minus refunds processed in that month */
  netRevenue: Decimal;
}

export interface Cohort extends CohortSize {
  /** repeatCustomers / customers to 4 dp; null for an empty cohort */
  repeatRate: number | null;
  months: Omit<CohortCell, 'month'>[];
}

/** The UTC first of a YYYY-MM month; null when it is not one. */
export function parseMonth(text: string): Date | null {
  const match = MONTH_TEXT.exec(text);
  if (!match) return null;
  const [year, month] = match.slice(1).map(Number);
  return new Date(Date.UTC(year, month - 1, 1));
}

export function monthsBetween(from: Date, to: Date): number {
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth();
}

export function addMonths(month: Date, months: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + months, 1));
}

/**
 * One cohort per month from `firstMonth` to `lastMonth`, each followed for up to `followMonths` months after its first
 * but never past `currentMonth`. Months nobody was active in are zeros, so every row of the matrix is complete.
 */
export function assembleCohorts(
  sizes: readonly CohortSize[],
  cells: readonly CohortCell[],
  {
    firstMonth,
    lastMonth,
    followMonths,
    currentMonth,
  }: Record<'firstMonth' | 'lastMonth' | 'currentMonth', Date> & {
    followMonths: number;
  },
): Cohort[] {
  const cohorts: Cohort[] = [];
  for (let month = firstMonth; month <= lastMonth; month = addMonths(month, 1)) {
    const size = sizes.find((each) => each.month.getTime() === month.getTime());
    const customers = size?.customers ?? 0;
    const repeatCustomers = size?.repeatCustomers ?? 0;
    const lastOffset = Math.min(followMonths, monthsBetween(month, currentMonth));
    const months: Cohort['months'] = [];
    for (let offset = 0; offset <= lastOffset; offset += 1) {
      const cell = cells.find((each) => each.month.getTime() === month.getTime() && each.offset === offset);
      months.push({
        offset,
        activeCustomers: cell?.activeCustomers ?? 0,
        orders: cell?.orders ?? 0,
        netRevenue: cell?.netRevenue ?? new Decimal(0),
      });
    }
    cohorts.push({
      month,
      customers,
      repeatCustomers,
      repeatRate: customers === 0 ? null : round(repeatCustomers / customers),
      months,
    });
  }
  return cohorts;
}

function round(value: number): number {
  const scale = 10 ** RATE_DECIMAL_PLACES;
  return Math.round(value * scale) / scale;
}
