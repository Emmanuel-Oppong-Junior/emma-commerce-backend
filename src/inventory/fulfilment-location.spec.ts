import {
  chooseFulfilmentLocation,
  firstUnfillableVariant,
  fulfilmentCandidates,
  quantitiesByVariant,
  sellableQuantity,
  StockAtLocation,
} from './fulfilment-location';

const level = (locationId: string, variantId: string, onHand: number, reserved = 0): StockAtLocation => ({
  locationId,
  variantId,
  onHand,
  reserved,
});

describe('fulfilmentCandidates', () => {
  it('keeps the active entries in priority order', () => {
    const list = [
      { locationId: 'b', isActive: true },
      { locationId: 'c', isActive: false },
      { locationId: 'a', isActive: true },
    ];
    expect(fulfilmentCandidates(list, 'main')).toEqual(['b', 'a']);
  });

  it('falls back to the default when the list is empty', () => {
    expect(fulfilmentCandidates([], 'main')).toEqual(['main']);
  });

  it('falls back to the default when every listed location is inactive', () => {
    expect(fulfilmentCandidates([{ locationId: 'b', isActive: false }], 'main')).toEqual(['main']);
  });
});

describe('quantitiesByVariant', () => {
  it('adds up lines of the same variant', () => {
    const lines = [
      { variantId: 'v1', quantity: 2 },
      { variantId: 'v2', quantity: 1 },
      { variantId: 'v1', quantity: 3 },
    ];
    expect(quantitiesByVariant(lines)).toEqual(
      new Map([
        ['v1', 5],
        ['v2', 1],
      ]),
    );
  });
});

describe('chooseFulfilmentLocation', () => {
  const lines = [
    { variantId: 'v1', quantity: 2 },
    { variantId: 'v2', quantity: 1 },
  ];

  it('takes the first candidate that can fill every line', () => {
    const levels = [level('a', 'v1', 5), level('a', 'v2', 5), level('b', 'v1', 5), level('b', 'v2', 5)];
    expect(chooseFulfilmentLocation(['b', 'a'], lines, levels)).toBe('b');
  });

  it('skips a candidate that lacks one line', () => {
    const levels = [level('a', 'v1', 5), level('b', 'v1', 5), level('b', 'v2', 1)];
    expect(chooseFulfilmentLocation(['a', 'b'], lines, levels)).toBe('b');
  });

  it('counts reserved units as unavailable', () => {
    const levels = [level('a', 'v1', 2, 1), level('a', 'v2', 1), level('b', 'v1', 2), level('b', 'v2', 1)];
    expect(chooseFulfilmentLocation(['a', 'b'], lines, levels)).toBe('b');
  });

  it('needs the summed quantity of lines of the same variant at one location', () => {
    const split = [
      { variantId: 'v1', quantity: 2 },
      { variantId: 'v1', quantity: 2 },
    ];
    expect(chooseFulfilmentLocation(['a', 'b'], split, [level('a', 'v1', 3), level('b', 'v1', 4)])).toBe('b');
  });

  it('is null when no single candidate can fill the order, even if together they could', () => {
    const levels = [level('a', 'v1', 5), level('b', 'v2', 5)];
    expect(chooseFulfilmentLocation(['a', 'b'], lines, levels)).toBeNull();
  });

  it('ignores stock at locations that are not candidates', () => {
    const levels = [level('x', 'v1', 5), level('x', 'v2', 5)];
    expect(chooseFulfilmentLocation(['a'], lines, levels)).toBeNull();
  });
});

describe('firstUnfillableVariant', () => {
  const lines = [
    { variantId: 'v1', quantity: 2 },
    { variantId: 'v2', quantity: 1 },
  ];

  it('names the first variant no candidate holds enough of', () => {
    expect(firstUnfillableVariant(['a', 'b'], lines, [level('a', 'v1', 5), level('b', 'v1', 1)])).toBe('v2');
  });

  it('is null when each variant is somewhere, even if not all at one location', () => {
    expect(firstUnfillableVariant(['a', 'b'], lines, [level('a', 'v1', 5), level('b', 'v2', 5)])).toBeNull();
  });
});

describe('sellableQuantity', () => {
  it('is the most available at any one location, not the sum', () => {
    expect(
      sellableQuantity([
        { onHand: 4, reserved: 1 },
        { onHand: 5, reserved: 0 },
      ]),
    ).toBe(5);
  });

  it('is zero without stock', () => {
    expect(sellableQuantity([])).toBe(0);
    expect(sellableQuantity([{ onHand: 2, reserved: 2 }])).toBe(0);
  });
});
