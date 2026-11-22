import { DigestItem, digestSections, isStillLow, PendingLowStockAlert, planDigest } from './low-stock-digest';

function alert(id: string, available: number, threshold: number | null = 5): PendingLowStockAlert {
  return { id, variantId: `v-${id}`, locationId: 'store_main', available, threshold };
}

describe('isStillLow', () => {
  it('is at or below the variant threshold, or the default of 5 without one', () => {
    expect(isStillLow(3, 3)).toBe(true);
    expect(isStillLow(4, 3)).toBe(false);
    expect(isStillLow(5, null)).toBe(true);
    expect(isStillLow(6, null)).toBe(false);
    expect(isStillLow(0, 0)).toBe(true);
  });
});

describe('planDigest', () => {
  it('lists variants still low and drops those that recovered before the digest', () => {
    const plan = planDigest([alert('a', 2), alert('b', 9), alert('c', 5), alert('d', 6, null)]);

    expect(plan.send.map((a) => a.id)).toEqual(['a', 'c']);
    expect(plan.drop.map((a) => a.id)).toEqual(['b', 'd']);
  });

  it('has nothing to send when nothing is pending', () => {
    expect(planDigest([])).toEqual({ send: [], drop: [] });
  });
});

describe('digestSections', () => {
  const item = (locationName: string, sku: string, available: number): DigestItem => ({
    locationName,
    productName: `Product ${sku}`,
    sku,
    available,
    threshold: 5,
  });

  it('groups by location name, emptiest variants first then by SKU', () => {
    const sections = digestSections([
      item('Main store', 'B-1', 3),
      item('Kumasi', 'K-1', 1),
      item('Main store', 'A-1', 3),
      item('Main store', 'C-1', 0),
    ]);

    expect(sections.map((s) => [s.locationName, s.items.map((i) => i.sku)])).toEqual([
      ['Kumasi', ['K-1']],
      ['Main store', ['C-1', 'A-1', 'B-1']],
    ]);
  });
});
