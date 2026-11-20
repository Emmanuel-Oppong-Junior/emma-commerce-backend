import { availableOf, consumeEffect, crossesLowStock, releaseEffect, reserveEffect } from './stock';

describe('stock rules (ADR-0008)', () => {
  it('counts available stock as on hand minus reserved over every location', () => {
    expect(availableOf([])).toBe(0);
    expect(
      availableOf([
        { onHand: 10, reserved: 4 },
        { onHand: 3, reserved: 3 },
      ]),
    ).toBe(6);
  });

  it('reserving holds units without taking them off hand', () => {
    expect(reserveEffect(2)).toEqual({ onHandDelta: 0, reservedDelta: 2, reason: 'RESERVE' });
  });

  it('consuming takes the units off hand and ends the hold, leaving available stock unchanged', () => {
    const effect = consumeEffect(2);
    expect(effect).toEqual({ onHandDelta: -2, reservedDelta: -2, reason: 'SALE' });
    expect(effect.onHandDelta - effect.reservedDelta).toBe(0);
  });

  it('releasing an active hold gives it back; releasing a consumed one restocks the units', () => {
    expect(releaseEffect('ACTIVE', 3)).toEqual({ onHandDelta: 0, reservedDelta: -3, reason: 'RELEASE' });
    expect(releaseEffect('CONSUMED', 3)).toEqual({ onHandDelta: 3, reservedDelta: 0, reason: 'RETURN_RESTOCK' });
  });

  it('never releases a reservation that is already released', () => {
    expect(releaseEffect('RELEASED', 3)).toBeNull();
  });

  describe('low-stock crossing', () => {
    it.each([
      [6, 5, 5, true],
      [10, 0, 5, true],
      [5, 4, 5, false],
      [5, 5, 5, false],
      [6, 6, 5, false],
      [3, 2, 0, false],
      [1, 0, 0, true],
    ])('from %i to %i available with threshold %i alerts: %s', (before, after, threshold, alerts) => {
      expect(crossesLowStock(before, after, threshold)).toBe(alerts);
    });

    it('uses a threshold of 5 when the variant has none', () => {
      expect(crossesLowStock(6, 5, null)).toBe(true);
      expect(crossesLowStock(7, 6, null)).toBe(false);
    });
  });
});
