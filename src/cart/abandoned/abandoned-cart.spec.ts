import { abandonedCartDecision, AbandonedCartFacts, cartStateHash, variantLabel } from './abandoned-cart';

const NOW = new Date('2026-12-10T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const facts = (overrides: Partial<AbandonedCartFacts> = {}): AbandonedCartFacts => ({
  lines: [
    { variantId: 'v1', quantity: 2, updatedAt: hoursAgo(6) },
    { variantId: 'v2', quantity: 1, updatedAt: hoursAgo(5) },
  ],
  lastOrderAt: null,
  remindedStateHashes: [],
  lastRemindedAt: null,
  hasMarketingConsent: true,
  ...overrides,
});

describe('cartStateHash', () => {
  it('depends on variants and quantities, not their order', () => {
    const a = cartStateHash([
      { variantId: 'v1', quantity: 2 },
      { variantId: 'v2', quantity: 1 },
    ]);
    expect(
      cartStateHash([
        { variantId: 'v2', quantity: 1 },
        { variantId: 'v1', quantity: 2 },
      ]),
    ).toBe(a);
    expect(
      cartStateHash([
        { variantId: 'v1', quantity: 3 },
        { variantId: 'v2', quantity: 1 },
      ]),
    ).not.toBe(a);
  });
});

describe('abandonedCartDecision', () => {
  it('reminds a consenting customer whose cart has been idle past the delay', () => {
    expect(abandonedCartDecision(facts(), NOW, 4)).toEqual({ remind: true, stateHash: cartStateHash(facts().lines) });
  });

  it('measures idleness from the last changed line', () => {
    const lines = [
      { variantId: 'v1', quantity: 1, updatedAt: hoursAgo(30) },
      { variantId: 'v2', quantity: 1, updatedAt: hoursAgo(3) },
    ];
    expect(abandonedCartDecision(facts({ lines }), NOW, 4)).toEqual({ remind: false, reason: 'TOO_RECENT' });
    expect(abandonedCartDecision(facts({ lines }), NOW, 2).remind).toBe(true);
  });

  it.each([
    ['an empty cart', { lines: [] }, 'EMPTY'],
    [
      'a cart older than 7 days',
      { lines: [{ variantId: 'v1', quantity: 1, updatedAt: hoursAgo(7 * 24 + 1) }] },
      'TOO_OLD',
    ],
    ['an order placed since the last change', { lastOrderAt: hoursAgo(1) }, 'ORDERED_SINCE'],
    ['no marketing consent', { hasMarketingConsent: false }, 'NO_CONSENT'],
    [
      'a cart state already reminded about',
      { remindedStateHashes: [cartStateHash(facts().lines)] },
      'ALREADY_REMINDED',
    ],
    ['a reminder within the last 7 days', { lastRemindedAt: hoursAgo(6 * 24) }, 'REMINDED_RECENTLY'],
  ] as const)('skips %s', (_name, overrides, reason) => {
    expect(abandonedCartDecision(facts(overrides as Partial<AbandonedCartFacts>), NOW, 4)).toEqual({
      remind: false,
      reason,
    });
  });

  it('still reminds when the last order came before the cart changed, or the last reminder over 7 days ago', () => {
    expect(abandonedCartDecision(facts({ lastOrderAt: hoursAgo(48) }), NOW, 4).remind).toBe(true);
    expect(abandonedCartDecision(facts({ lastRemindedAt: hoursAgo(8 * 24) }), NOW, 4).remind).toBe(true);
  });
});

describe('variantLabel', () => {
  it('joins option values and is empty for a default variant', () => {
    expect(variantLabel({ size: 'M', colour: 'Red' })).toBe('M, Red');
    expect(variantLabel({})).toBe('');
    expect(variantLabel(null)).toBe('');
  });
});
