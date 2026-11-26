import { pendingPurge, planPurges } from './purge-plan';

describe('planPurges', () => {
  it('purges each key once however many changes asked for it, with every reason behind it', () => {
    const pending = [
      pendingPurge('product', 'product:p1'),
      pendingPurge('product', 'products'),
      pendingPurge('stock', 'product:p1'),
      pendingPurge('stock', 'products'),
      pendingPurge('brand', 'brand:b1'),
    ];

    expect(planPurges(pending)).toEqual([
      { keys: ['brand:b1', 'product:p1', 'products'], reasons: ['brand', 'product', 'stock'] },
    ]);
  });

  it('sends only catalogue when a window holds a store-wide purge', () => {
    const pending = [pendingPurge('product', 'product:p1'), pendingPurge('promotion', 'catalogue')];
    expect(planPurges(pending)).toEqual([{ keys: ['catalogue'], reasons: ['product', 'promotion'] }]);
  });

  it('splits a large window into calls of at most the batch size, each with its own reasons', () => {
    const pending = [
      pendingPurge('product', 'product:a'),
      pendingPurge('product', 'product:b'),
      pendingPurge('banner', 'products'),
    ];
    expect(planPurges(pending, 2)).toEqual([
      { keys: ['product:a', 'product:b'], reasons: ['product'] },
      { keys: ['products'], reasons: ['banner'] },
    ]);
  });

  it('plans nothing for an empty window', () => {
    expect(planPurges([])).toEqual([]);
  });

  it.each(['product:p1', '|product:p1', 'nonsense|product:p1', 'product|'])(
    'refuses a malformed pending entry (%s)',
    (entry) => {
      expect(() => planPurges([entry])).toThrow('Malformed pending CDN purge');
    },
  );
});
