import { Decimal } from '@prisma/client/runtime/client';

/** Unit costs are kept to 4 decimal places (Variant.costPrice is DECIMAL(14,4)), rounded half-up. */
export const COST_DECIMAL_PLACES = 4;

/**
 * The variant's weighted-average unit cost after receiving `quantity` units at `unitCost`:
 * (onHandBefore × oldCost + quantity × unitCost) / (onHandBefore + quantity), rounded half-up to 4 dp.
 * `onHandBefore` is the variant's on-hand stock over every location just before the receipt. With no known cost or
 * nothing on hand (0 or, defensively, below) the received units set the cost alone.
 */
export function weightedAverageCost(
  oldCost: Decimal | null,
  onHandBefore: number,
  quantity: number,
  unitCost: Decimal,
): Decimal {
  if (!Number.isInteger(quantity) || quantity < 1)
    throw new RangeError(`Received quantity must be >= 1, got ${quantity}`);
  if (oldCost === null || onHandBefore <= 0)
    return unitCost.toDecimalPlaces(COST_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
  const total = oldCost.mul(onHandBefore).add(unitCost.mul(quantity));
  return total.div(onHandBefore + quantity).toDecimalPlaces(COST_DECIMAL_PLACES, Decimal.ROUND_HALF_UP);
}
