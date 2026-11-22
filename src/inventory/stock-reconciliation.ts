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
  /** a lot's units at a location are not the sum of its movements there (P4-C.1) */
  LotMovements = 'LOT_MOVEMENTS',
  /** a lot-tracked variant's onHand at a location is not the sum of its lots there (P4-C.1) */
  LotTotal = 'LOT_TOTAL',
}

export interface StockMismatch {
  kind: StockMismatchKind;
  variantId: string;
  locationId: string;
  /** Set on LOT_MOVEMENTS */
  lotId?: string;
  expected: number;
  actual: number;
}

/** A lot or lot total that disagrees with the ledger, as the reconciliation query reads it. */
export interface LotTotals {
  kind: 'LOT_MOVEMENTS' | 'LOT_TOTAL';
  variantId: string;
  locationId: string;
  lotId: string | null;
  expected: number;
  actual: number;
}

/** The lot disagreements as mismatches (the query returns only rows that disagree). */
export function lotMismatches(rows: readonly LotTotals[]): StockMismatch[] {
  return rows
    .filter((row) => row.expected !== row.actual)
    .map(({ kind, variantId, locationId, lotId, expected, actual }) => ({
      kind: kind === 'LOT_MOVEMENTS' ? StockMismatchKind.LotMovements : StockMismatchKind.LotTotal,
      variantId,
      locationId,
      ...(lotId && { lotId }),
      expected,
      actual,
    }));
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

/** Mismatch counts by kind, every kind present (0 when clean), for the metric. */
export function countByKind(mismatches: StockMismatch[]): Record<StockMismatchKind, number> {
  const counts = Object.fromEntries(Object.values(StockMismatchKind).map((kind) => [kind, 0])) as Record<
    StockMismatchKind,
    number
  >;
  for (const { kind } of mismatches) counts[kind] += 1;
  return counts;
}
