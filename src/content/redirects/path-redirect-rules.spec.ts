import { chainStatus, redirectKey, wouldLoop } from './path-redirect-rules';

describe('path redirect rules', () => {
  it('looks paths up without query, fragment or trailing slash', () => {
    expect(redirectKey('/old-sale/?utm=x')).toBe('/old-sale');
    expect(redirectKey('/old#top')).toBe('/old');
    expect(redirectKey('/')).toBe('/');
  });

  it('makes a chain permanent only when every hop is', () => {
    expect(chainStatus([301, 301])).toBe(301);
    expect(chainStatus([301, 302])).toBe(302);
  });

  describe('wouldLoop', () => {
    const existing = new Map([
      ['/b', '/c'],
      ['/c', '/d?x=1'],
    ]);

    it('allows a redirect that ends somewhere new', () => {
      expect(wouldLoop('/a', '/b', existing)).toBe(false);
      expect(wouldLoop('/x', '/y', existing)).toBe(false);
    });

    it('refuses a redirect that comes back to its own path through the chain', () => {
      expect(wouldLoop('/d', '/b', existing)).toBe(true);
      expect(wouldLoop('/c/', '/b?ref=1', existing)).toBe(true);
    });

    it('refuses a redirect to itself', () => {
      expect(wouldLoop('/a', '/a/', new Map())).toBe(true);
    });

    it('stops on an existing loop instead of spinning', () => {
      const looped = new Map([
        ['/p', '/q'],
        ['/q', '/p'],
      ]);
      expect(wouldLoop('/z', '/p', looped)).toBe(true);
    });
  });
});
