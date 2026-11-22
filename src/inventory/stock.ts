import { StockMovementReason, StockReservationStatus } from '../generated/prisma/client';

/** Used when a variant has no lowStockThreshold of its own. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

export interface StockCounts {
  onHand: number;
  reserved: number;
}

/** One StockLevel change, recorded as one StockMovement. */
export interface StockEffect {
  onHandDelta: number;
  reservedDelta: number;
  reason: StockMovementReason;
}

/** Units that can still be sold: on hand and not held by a reservation, summed over locations. */
export function availableOf(levels: StockCounts[]): number {
  return levels.reduce((sum, level) => sum + level.onHand - level.reserved, 0);
}

/** Holding units for an order line: they stay on hand but are no longer available. */
export function reserveEffect(quantity: number): StockEffect {
  return { onHandDelta: 0, reservedDelta: quantity, reason: StockMovementReason.RESERVE };
}

/** An ACTIVE reservation is consumed when the sale happens: the units leave on-hand stock and the hold ends. */
export function consumeEffect(quantity: number): StockEffect {
  return { onHandDelta: -quantity, reservedDelta: -quantity, reason: StockMovementReason.SALE };
}

/** Units leaving a location on a transfer: only available ones, so stock reserved for orders stays. */
export function transferOutEffect(quantity: number): StockEffect {
  return { onHandDelta: -quantity, reservedDelta: 0, reason: StockMovementReason.TRANSFER };
}

/** Units arriving at a location on a transfer. */
export function transferInEffect(quantity: number): StockEffect {
  return { onHandDelta: quantity, reservedDelta: 0, reason: StockMovementReason.TRANSFER };
}

/**
 * Giving back a reservation's units on cancel or expiry. An ACTIVE hold just ends. A CONSUMED one has already left
 * on-hand stock (paid online, or an order placed before the ledger) but the order is cancelled before dispatch, so
 * the goods never left the store and go back on hand.
 */
export function releaseEffect(from: StockReservationStatus, quantity: number): StockEffect | null {
  if (from === StockReservationStatus.ACTIVE) {
    return { onHandDelta: 0, reservedDelta: -quantity, reason: StockMovementReason.RELEASE };
  }
  if (from === StockReservationStatus.CONSUMED) {
    return { onHandDelta: quantity, reservedDelta: 0, reason: StockMovementReason.RETURN_RESTOCK };
  }
  return null;
}

/** Whether a change takes available stock from above the threshold to at or below it (alert once per crossing). */
export function crossesLowStock(availableBefore: number, availableAfter: number, threshold: number | null): boolean {
  const limit = threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  return availableBefore > limit && availableAfter <= limit;
}
