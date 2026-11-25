import { guestOrderToken, guestOrderTokenKey, guestOrderUrl, orderIdFromGuestToken } from './guest-order-token';

const KEY = guestOrderTokenKey(Buffer.alloc(32, 7));

describe('guest order tokens', () => {
  it('reads back the order a token was issued for', () => {
    expect(orderIdFromGuestToken(KEY, guestOrderToken(KEY, 'order1'))).toBe('order1');
  });

  it('refuses the token of another order with its signature swapped in', () => {
    const signature = guestOrderToken(KEY, 'order1').split('.')[1];
    expect(orderIdFromGuestToken(KEY, `order2.${signature}`)).toBeNull();
  });

  it('refuses a token signed with another key', () => {
    const otherKey = guestOrderTokenKey(Buffer.alloc(32, 8));
    expect(orderIdFromGuestToken(KEY, guestOrderToken(otherKey, 'order1'))).toBeNull();
  });

  it.each(['', 'order1', '.abc', 'order1.', 'or-der1.abc', `order1.${'A'.repeat(43)}`])('refuses %p', (token) => {
    expect(orderIdFromGuestToken(KEY, token)).toBeNull();
  });

  it('derives the key from the MFA key with its own label', () => {
    expect(guestOrderTokenKey(Buffer.alloc(32, 7))).toEqual(KEY);
    expect(guestOrderTokenKey(Buffer.alloc(32, 7))).not.toEqual(Buffer.alloc(32, 7));
  });

  it('puts the token in the fragment of the storefront link', () => {
    expect(guestOrderUrl('https://shop.example.com/', 'order1.sig')).toBe(
      'https://shop.example.com/guest-order#token=order1.sig',
    );
  });
});
