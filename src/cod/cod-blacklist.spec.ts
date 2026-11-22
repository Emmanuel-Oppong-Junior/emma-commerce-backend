import { blacklistKeyOf, checkoutBlacklistKeys, normaliseGhanaPostGps, normaliseStreet } from './cod-blacklist';

describe('COD blacklist keys', () => {
  it('normalises GhanaPost GPS codes', () => {
    for (const code of ['GA-183-8164', 'ga 183 8164', 'GA1838164'])
      expect(normaliseGhanaPostGps(code)).toBe('GA1838164');
  });

  it('normalises streets: case, punctuation, accents and spacing', () => {
    expect(normaliseStreet('  12 Oxford St.,  Osu ')).toBe('12 oxford st osu');
    expect(normaliseStreet('Rue Café')).toBe('rue cafe');
  });

  describe('blacklistKeyOf', () => {
    it('stores a Ghana phone in E.164 whatever the format', () => {
      expect(blacklistKeyOf({ phone: '024 412 3456' })).toEqual({ kind: 'PHONE', value: '+233244123456' });
    });

    it('stores a GPS code without separators', () => {
      expect(blacklistKeyOf({ ghanaPostGps: 'ga-183-8164' })).toEqual({ kind: 'GHANA_POST_GPS', value: 'GA1838164' });
    });

    it('stores a street with its city', () => {
      expect(blacklistKeyOf({ street: '12 Oxford St.', city: ' Accra ' })).toEqual({
        kind: 'STREET_ADDRESS',
        value: '12 oxford st|accra',
      });
    });

    it.each([
      [{}, 'Give exactly one'],
      [{ phone: '0244123456', ghanaPostGps: 'GA1838164' }, 'Give exactly one'],
      [{ phone: '0244123456', street: 'x', city: 'Accra' }, 'Give exactly one'],
      [{ street: '12 Oxford St' }, 'street and city are both required'],
      [{ city: 'Accra' }, 'street and city are both required'],
      [{ street: '...', city: 'Accra' }, 'street and city are both required'],
      [{ phone: 'abc' }, 'phone must contain digits'],
      [{ ghanaPostGps: '--' }, 'ghanaPostGps must contain letters or digits'],
    ])('refuses %p', (target, message) => {
      expect(() => blacklistKeyOf(target)).toThrow(message);
    });
  });

  describe('checkoutBlacklistKeys', () => {
    it('matches every phone, the GPS code and the street of a delivery', () => {
      const keys = checkoutBlacklistKeys(['+233244123456', '0201234567'], {
        phone: '0551234567',
        ghanaPostGps: 'GA-183-8164',
        street: '12 Oxford St.',
        city: 'Accra',
      });
      expect(keys).toEqual([
        { kind: 'PHONE', value: '+233244123456' },
        { kind: 'PHONE', value: '+233201234567' },
        { kind: 'PHONE', value: '+233551234567' },
        { kind: 'GHANA_POST_GPS', value: 'GA1838164' },
        { kind: 'STREET_ADDRESS', value: '12 oxford st|accra' },
      ]);
    });

    it('matches what staff entered for the same address in another spelling', () => {
      const staff = blacklistKeyOf({ street: '12, OXFORD ST', city: 'accra' });
      const checkout = checkoutBlacklistKeys([], { street: '12 Oxford St', city: 'Accra' });
      expect(checkout).toContainEqual(staff);
    });

    it('matches only the phones of a pickup, skipping missing ones', () => {
      expect(checkoutBlacklistKeys([null, undefined, '+233244123456'], null)).toEqual([
        { kind: 'PHONE', value: '+233244123456' },
      ]);
    });
  });
});
