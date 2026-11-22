import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';

/** One rider's figures for the range, as the report query aggregates them. */
export interface RiderCashRow {
  riderId: string;
  riderName: string | null;
  collectionsCount: number;
  collectedTotal: Prisma.Decimal;
  outstandingCount: number;
  outstandingTotal: Prisma.Decimal;
  remittancesCount: number;
  remittedTotal: Prisma.Decimal;
  discrepancyCount: number;
  shortTotal: Prisma.Decimal;
  overTotal: Prisma.Decimal;
}

export interface RiderCashSummary extends RiderCashRow {
  netDiscrepancy: string;
}

export type CashTotals = Omit<RiderCashSummary, 'riderId' | 'riderName'>;

export interface RiderPage {
  first: number;
  after?: string;
}

export interface RiderCashReport {
  riders: RiderCashSummary[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; pageSize: number; totalCount: number };
  totals: CashTotals;
}

export function assertReportRange(from: Date, to: Date): void {
  if (from.getTime() >= to.getTime()) {
    throw new BadRequestException(`from (${from.toISOString()}) must be before to (${to.toISOString()})`);
  }
}

function netDiscrepancy(row: { shortTotal: Prisma.Decimal; overTotal: Prisma.Decimal }): string {
  return row.overTotal.minus(row.shortTotal).toFixed(2);
}

function totalsOf(rows: RiderCashRow[]): CashTotals {
  const zero = new Prisma.Decimal(0);
  const sums = rows.reduce(
    (sum, row) => ({
      collectionsCount: sum.collectionsCount + row.collectionsCount,
      collectedTotal: sum.collectedTotal.plus(row.collectedTotal),
      outstandingCount: sum.outstandingCount + row.outstandingCount,
      outstandingTotal: sum.outstandingTotal.plus(row.outstandingTotal),
      remittancesCount: sum.remittancesCount + row.remittancesCount,
      remittedTotal: sum.remittedTotal.plus(row.remittedTotal),
      discrepancyCount: sum.discrepancyCount + row.discrepancyCount,
      shortTotal: sum.shortTotal.plus(row.shortTotal),
      overTotal: sum.overTotal.plus(row.overTotal),
    }),
    {
      collectionsCount: 0,
      collectedTotal: zero,
      outstandingCount: 0,
      outstandingTotal: zero,
      remittancesCount: 0,
      remittedTotal: zero,
      discrepancyCount: 0,
      shortTotal: zero,
      overTotal: zero,
    },
  );
  return { ...sums, netDiscrepancy: netDiscrepancy(sums) };
}

/**
 * Pages the riders by id (`after` is the last rider id of the previous page) and totals every rider in the range, so
 * the totals do not depend on the page. Riders are staff accounts, so the whole set is small enough to total here.
 */
export function buildRiderCashReport(rows: RiderCashRow[], page: RiderPage): RiderCashReport {
  const sorted = [...rows].sort((a, b) => (a.riderId < b.riderId ? -1 : a.riderId > b.riderId ? 1 : 0));
  const { after } = page;
  const rest = after === undefined ? sorted : sorted.filter((row) => row.riderId > after);
  const riders = rest.slice(0, page.first).map((row) => ({ ...row, netDiscrepancy: netDiscrepancy(row) }));
  return {
    riders,
    pageInfo: {
      hasNextPage: rest.length > page.first,
      hasPreviousPage: rest.length < sorted.length,
      pageSize: riders.length,
      totalCount: sorted.length,
    },
    totals: totalsOf(sorted),
  };
}
