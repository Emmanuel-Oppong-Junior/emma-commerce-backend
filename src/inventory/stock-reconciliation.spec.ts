import {
  countByKind,
  LedgerTotals,
  serialUnitsMismatch,
  StockMismatchKind,
  stockMismatches,
} from './stock-reconciliation';

const balanced: LedgerTotals = {
  variantId: 'v1',
  locationId: 'loc',
  onHand: 10,
  reserved: 3,
  movedOnHand: 10,
  movedReserved: 3,
  activeReserved: 3,
};

describe('stock reconciliation', () => {
  it('finds nothing when the level matches its movements and its active reservations', () => {
    expect(stockMismatches(balanced)).toEqual([]);
  });

  it('reports on-hand stock the movements do not explain, with expected and actual values', () => {
    expect(stockMismatches({ ...balanced, onHand: 12 })).toEqual([
      { kind: StockMismatchKind.OnHand, variantId: 'v1', locationId: 'loc', expected: 10, actual: 12 },
    ]);
  });

  it('reports reserved stock that differs from the movements and from the active reservations separately', () => {
    expect(stockMismatches({ ...balanced, movedReserved: 2, activeReserved: 4 }).map((m) => m.kind)).toEqual([
      StockMismatchKind.ReservedMovements,
      StockMismatchKind.ActiveReservations,
    ]);
  });

  it('treats a missing level as zero, so movements without a level are reported', () => {
    expect(stockMismatches({ ...balanced, onHand: 0, reserved: 0, movedReserved: 0, activeReserved: 0 })).toEqual([
      { kind: StockMismatchKind.OnHand, variantId: 'v1', locationId: 'loc', expected: 10, actual: 0 },
    ]);
  });

  it('counts mismatches for every kind, zero included', () => {
    const mismatches = [
      ...stockMismatches({ ...balanced, onHand: 1 }),
      ...stockMismatches({ ...balanced, variantId: 'v2', onHand: 2 }),
    ];

    expect(countByKind(mismatches)).toEqual({ ON_HAND: 2, RESERVED_MOVEMENTS: 0, ACTIVE_RESERVATIONS: 0 });
  });

  it('reports a serial-tracked variant whose units on the shelf differ from what the ledger expects there', () => {
    expect(serialUnitsMismatch({ variantId: 'v1', locationId: 'loc', expected: 3, units: 3 })).toBeNull();
    expect(serialUnitsMismatch({ variantId: 'v1', locationId: 'loc', expected: 3, units: 2 })).toEqual({
      kind: 'SERIAL_UNITS',
      variantId: 'v1',
      locationId: 'loc',
      expected: 3,
      actual: 2,
    });
  });
});
