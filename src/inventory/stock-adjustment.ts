import { StockAdjustmentReason } from '../generated/prisma/client';

const R = StockAdjustmentReason;

/** Reasons staff may give by hand; STOCK_TAKE is recorded only when a stock-take is approved. */
export const MANUAL_ADJUSTMENT_REASONS: StockAdjustmentReason[] = [
  R.DAMAGED,
  R.LOST,
  R.FOUND,
  R.EXPIRED,
  R.CORRECTION,
  R.OTHER,
];

/** Reasons that can only take stock away, or only add it; CORRECTION and OTHER go either way. */
const REMOVES_STOCK: StockAdjustmentReason[] = [R.DAMAGED, R.LOST, R.EXPIRED];
const ADDS_STOCK: StockAdjustmentReason[] = [R.FOUND];

export interface ManualAdjustment {
  delta: number;
  reason: StockAdjustmentReason;
  note?: string | null;
}

/** Why a manual adjustment is refused, or null when it is valid. */
export function manualAdjustmentError({ delta, reason, note }: ManualAdjustment): string | null {
  if (!MANUAL_ADJUSTMENT_REASONS.includes(reason)) return `${reason} cannot be given by hand`;
  if (!Number.isInteger(delta) || delta === 0) return `The change must be a non-zero whole number, got ${delta}`;
  if (REMOVES_STOCK.includes(reason) && delta > 0) return `${reason} can only remove stock: send a negative delta`;
  if (ADDS_STOCK.includes(reason) && delta < 0) return `${reason} can only add stock: send a positive delta`;
  if (reason === R.OTHER && !note?.trim()) return 'A note is required when the reason is OTHER';
  return null;
}
