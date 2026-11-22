import { StockCounts } from './stock';

/** One entry of a shipping zone's or pickup point's fulfilment list, in priority order. */
export interface FulfilmentListEntry {
  locationId: string;
  isActive: boolean;
}

export interface StockAtLocation extends StockCounts {
  variantId: string;
  locationId: string;
}

/**
 * The locations that may fulfil an order, in the order they are tried: the active entries of the list, or the
 * default location when none is configured or every listed one is inactive (a temporarily closed branch should not
 * stop sales the default can serve).
 */
export function fulfilmentCandidates(list: readonly FulfilmentListEntry[], defaultLocationId: string): string[] {
  const active = list.filter((entry) => entry.isActive).map((entry) => entry.locationId);
  return active.length > 0 ? active : [defaultLocationId];
}

/** Units of each variant the lines need (an order can hold a variant on several lines after a flash-sale split). */
export function quantitiesByVariant(lines: readonly { variantId: string; quantity: number }[]): Map<string, number> {
  const needed = new Map<string, number>();
  for (const line of lines) needed.set(line.variantId, (needed.get(line.variantId) ?? 0) + line.quantity);
  return needed;
}

/**
 * The first candidate that has every line available (onHand - reserved) on its own, or null when none can: an order
 * is reserved and fulfilled from one location (split shipments come later).
 */
export function chooseFulfilmentLocation(
  candidates: readonly string[],
  lines: readonly { variantId: string; quantity: number }[],
  levels: readonly StockAtLocation[],
): string | null {
  const needed = quantitiesByVariant(lines);
  const canFill = filler(levels);
  return candidates.find((locationId) => [...needed].every((entry) => canFill(locationId, ...entry))) ?? null;
}

/** The first variant of the lines that no candidate holds enough of on its own, or null when each one is somewhere. */
export function firstUnfillableVariant(
  candidates: readonly string[],
  lines: readonly { variantId: string; quantity: number }[],
  levels: readonly StockAtLocation[],
): string | null {
  const canFill = filler(levels);
  const unfillable = [...quantitiesByVariant(lines)].find(
    ([variantId, quantity]) => !candidates.some((locationId) => canFill(locationId, variantId, quantity)),
  );
  return unfillable?.[0] ?? null;
}

function filler(levels: readonly StockAtLocation[]) {
  const availableAt = new Map(levels.map((l) => [`${l.locationId}|${l.variantId}`, l.onHand - l.reserved]));
  return (locationId: string, variantId: string, quantity: number) =>
    (availableAt.get(`${locationId}|${variantId}`) ?? 0) >= quantity;
}

/**
 * What a customer can buy of one variant in a single order: the most available at any one location that can serve
 * them. Never the sum, because placement takes a whole order from one location.
 */
export function sellableQuantity(levels: readonly StockCounts[]): number {
  return levels.reduce((best, level) => Math.max(best, level.onHand - level.reserved), 0);
}
