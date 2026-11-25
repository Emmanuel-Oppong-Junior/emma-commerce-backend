import {
  GUEST_CART_IDLE_DAYS,
  guestCartExpiry,
  guestCartTokenHash,
  guestOtpSubject,
  newGuestCartToken,
} from './guest-cart-token';

describe('guest cart tokens', () => {
  it('makes a prefixed token from 32 random bytes', () => {
    const token = newGuestCartToken((size) => Buffer.alloc(size, 1));
    expect(token).toBe(`gct_${Buffer.alloc(32, 1).toString('base64url')}`);
    expect(token).toHaveLength(4 + 43);
  });

  it('gives a different token each time', () => {
    expect(newGuestCartToken()).not.toBe(newGuestCartToken());
  });

  it('stores the SHA-256 of the token, never the token', () => {
    const token = newGuestCartToken();
    const hash = guestCartTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    expect(guestCartTokenHash(token)).toBe(hash);
  });

  it.each(['', 'gct_short', `xyz_${'a'.repeat(43)}`, `gct_${'a'.repeat(42)}!`, `gct_${'a'.repeat(44)}`])(
    'refuses %p as a token',
    (value) => {
      expect(guestCartTokenHash(value)).toBeNull();
    },
  );

  it(`expires a cart ${GUEST_CART_IDLE_DAYS} days after its last use`, () => {
    expect(guestCartExpiry(new Date('2026-12-01T10:00:00Z'))).toEqual(new Date('2026-12-31T10:00:00Z'));
  });

  it('binds a guest phone code to a subject no account id can equal', () => {
    expect(guestOtpSubject('cart1')).toBe('guest:cart1');
  });
});
