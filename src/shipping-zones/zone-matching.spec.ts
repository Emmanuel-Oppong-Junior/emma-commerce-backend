import {
  candidateKeys,
  isGhana,
  matchKey,
  matchZone,
  normalisePlaceName,
  toZoneArea,
  ZoneAreaValue,
} from './zone-matching';

const entry = (zoneId: string, value: ZoneAreaValue) => ({ zoneId, ...value });
const region = (zoneId: string) => entry(zoneId, { level: 'REGION', region: 'GREATER_ACCRA', town: null, area: null });
const town = (zoneId: string, name = 'accra') => entry(zoneId, { level: 'TOWN', region: null, town: name, area: null });
const area = (zoneId: string, name = 'osu') =>
  entry(zoneId, { level: 'AREA', region: null, town: 'accra', area: name });
const osu = { country: 'GH', region: 'GREATER_ACCRA' as const, city: 'Accra', area: 'Osu' };

describe('normalisePlaceName', () => {
  it.each([
    ['  East   Legon ', 'east legon'],
    ['East-Legon', 'east legon'],
    ['ÉAST LÉGON', 'east legon'],
    ["Kwame Nkrumah's Circle", 'kwame nkrumahs circle'],
    ['Adabraka.', 'adabraka'],
    ['Tema Comm. 25', 'tema comm 25'],
    [' - ', ''],
  ])('%p becomes %p', (raw, normalised) => {
    expect(normalisePlaceName(raw)).toBe(normalised);
  });
});

describe('isGhana', () => {
  it.each([
    ['GH', true],
    [' gh ', true],
    ['Ghana', true],
    ['NG', false],
    ['Togo', false],
  ])('%p -> %p', (country, expected) => expect(isGhana(country)).toBe(expected));
});

describe('toZoneArea', () => {
  it.each([
    [{ region: 'VOLTA' as const }, { level: 'REGION', region: 'VOLTA', town: null, area: null }],
    [{ town: ' Kumasi ' }, { level: 'TOWN', region: null, town: 'kumasi', area: null }],
    [
      { town: 'Accra', area: 'Osu-RE' },
      { level: 'AREA', region: null, town: 'accra', area: 'osu re' },
    ],
  ])('turns %p into its stored form', (spec, stored) => {
    expect(toZoneArea(spec)).toEqual(stored);
  });

  it.each([
    [{}],
    [{ area: 'Osu' }],
    [{ region: 'VOLTA' as const, town: 'Ho' }],
    [{ town: '...' }],
    [{ town: 'Accra', area: '' }],
  ])('explains why %p is not an entry', (spec) => {
    expect(typeof toZoneArea(spec)).toBe('string');
  });

  it('gives each level its own key', () => {
    expect([region('z'), town('z'), area('z')].map(matchKey)).toEqual([
      'REGION:GREATER_ACCRA',
      'TOWN:accra',
      'AREA:accra|osu',
    ]);
  });
});

describe('candidateKeys', () => {
  it('lists the area of the town, the town and the region, most specific first', () => {
    expect(candidateKeys({ region: 'GREATER_ACCRA', city: ' ACCRA ', area: 'Osu' })).toEqual([
      'AREA:accra|osu',
      'TOWN:accra',
      'REGION:GREATER_ACCRA',
    ]);
  });

  it('leaves out what the address does not have', () => {
    expect(candidateKeys({ region: null, city: 'Accra', area: null })).toEqual(['TOWN:accra']);
  });
});

describe('matchZone', () => {
  it('prefers an area of the town over the town over the region, whatever order they come in', () => {
    expect(matchZone([region('r'), area('a'), town('t')], osu)?.zoneId).toBe('a');
    expect(matchZone([region('r'), town('t')], osu)?.zoneId).toBe('t');
    expect(matchZone([region('r')], osu)?.zoneId).toBe('r');
  });

  it('ignores entries the address does not match', () => {
    expect(matchZone([area('a', 'labone'), town('t', 'tema')], osu)).toBeNull();
  });

  it('refuses an address outside Ghana even when its city matches', () => {
    expect(matchZone([town('t')], { ...osu, country: 'NG' })).toBeNull();
  });

  it('matches regardless of how the customer spelt the town and area', () => {
    expect(matchZone([area('a')], { ...osu, city: 'accra ', area: 'OSU' })?.zoneId).toBe('a');
  });
});
