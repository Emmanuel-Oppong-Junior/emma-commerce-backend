import { ConflictException } from '@nestjs/common';
import { StockTakeStatus } from '../../generated/prisma/client';

const S = StockTakeStatus;

/**
 * The stock-take machine (P4-B.1): counters count while OPEN and submit; an approver approves a SUBMITTED session
 * (its variances are posted) or cancels it, at any time before approval.
 */
const TRANSITIONS: Record<StockTakeStatus, StockTakeStatus[]> = {
  OPEN: [S.SUBMITTED, S.CANCELLED],
  SUBMITTED: [S.APPROVED, S.CANCELLED],
  APPROVED: [],
  CANCELLED: [],
};

/** Sessions that still hold their location: a second one cannot open there until they are approved or cancelled. */
export const ACTIVE_STOCK_TAKE_STATUSES: StockTakeStatus[] = [S.OPEN, S.SUBMITTED];

export function canStockTakeTransition(from: StockTakeStatus, to: StockTakeStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function stockTakeStatusesFrom(to: StockTakeStatus): StockTakeStatus[] {
  return (Object.keys(TRANSITIONS) as StockTakeStatus[]).filter((from) => canStockTakeTransition(from, to));
}

export function assertStockTakeTransition(id: string, from: StockTakeStatus, to: StockTakeStatus): void {
  if (!canStockTakeTransition(from, to)) {
    throw new ConflictException(`Stock-take "${id}" cannot move from ${from} to ${to}`);
  }
}
