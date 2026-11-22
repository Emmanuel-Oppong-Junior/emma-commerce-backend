/** What the ledger says about one (variant, location), next to its StockLevel (zeros where a side has no rows). */
export interface LedgerTotals {
  variantId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  movedOnHand: number;
  movedReserved: number;
  activeReserved: number;
}

export enum StockMismatchKind {
  /** onHand is not the sum of the movements' onHandDelta */
  OnHand = 'ON_HAND',
  /** reserved is not the sum of the movements' reservedDelta */
  ReservedMovements = 'RESERVED_MOVEMENTS',
  /** reserved is not the quantity of the ACTIVE reservations */
  ActiveReservations = 'ACTIVE_RESERVATIONS',
}

/** Units of a serial-tracked variant on the shelf differ from what the ledger expects there (P4-D.1). */
export const SERIAL_UNITS_MISMATCH = 'SERIAL_UNITS';

export interface SerialUnitsMismatch extends Omit<StockMismatch, 'kind'> {
  kind: typeof SERIAL_UNITS_MISMATCH;
}

export interface StockMismatch {
  kind: StockMismatchKind;
  variantId: string;
  locationId: string;
  expected: number;
  actual: number;
}

/** The ways a level disagrees with its ledger; empty when it reconciles. Never corrects anything. */
export function stockMismatches(totals: LedgerTotals): StockMismatch[] {
  const { variantId, locationId } = totals;
  const checks: [StockMismatchKind, number, number][] = [
    [StockMismatchKind.OnHand, totals.movedOnHand, totals.onHand],
    [StockMismatchKind.ReservedMovements, totals.movedReserved, totals.reserved],
    [StockMismatchKind.ActiveReservations, totals.activeReserved, totals.reserved],
  ];
  return checks
    .filter(([, expected, actual]) => expected !== actual)
    .map(([kind, expected, actual]) => ({ kind, variantId, locationId, expected, actual }));
}

/**
 * A serial-tracked variant at a location whose IN_STOCK + ASSIGNED units differ from onHand plus its units sold online
 * and not yet dispatched (expected); null when they agree.
 */
export function serialUnitsMismatch(totals: {
  variantId: string;
  locationId: string;
  expected: number;
  units: number;
}): SerialUnitsMismatch | null {
  if (totals.expected === totals.units) return null;
  const { variantId, locationId, expected, units } = totals;
  return { kind: SERIAL_UNITS_MISMATCH, variantId, locationId, expected, actual: units };
}

/** Mismatch counts by kind, every ledger kind present (0 when clean), for the metric. */
export function countByKind(mismatches: StockMismatch[]): Record<StockMismatchKind, number> {
  const counts = Object.fromEntries(Object.values(StockMismatchKind).map((kind) => [kind, 0])) as Record<
    StockMismatchKind,
    number
  >;
  for (const { kind } of mismatches) counts[kind] += 1;
  return counts;
}
