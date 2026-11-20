import { normaliseGhanaPostGps } from './ghana-post-gps';

describe('normaliseGhanaPostGps', () => {
  it.each([
    ['GA1234567', 'GA-123-4567'],
    ['GA12345678', 'GA-1234-5678'],
    ['ga-123-4567', 'GA-123-4567'],
    ['AK-484-9321', 'AK-484-9321'],
    ['AK-4849-3215', 'AK-4849-3215'],
    ['  ak 484 9321 ', 'AK-484-9321'],
    ['GA-1234567', 'GA-123-4567'],
    ['GA123-4567', 'GA-123-4567'],
    ['g a - 1 2 3 - 4 5 6 7', 'GA-123-4567'],
  ])('normalises %p to %p', (input, expected) => {
    expect(normaliseGhanaPostGps(input)).toBe(expected);
  });

  it.each([
    ['', 'empty'],
    ['GA-12-4567', 'first group too short'],
    ['GA-12345-6789', 'first group too long'],
    ['GA-123-456', 'last group too short'],
    ['GA-123-45678', 'last group too long'],
    ['G-123-4567', 'one letter'],
    ['GAX-123-4567', 'three letters'],
    ['12-123-4567', 'digits for letters'],
    ['GA--123-4567', 'doubled hyphen'],
    ['GA_123_4567', 'underscores'],
    ['Accra', 'not a digital address'],
  ])('rejects %p (%s)', (input) => {
    expect(normaliseGhanaPostGps(input)).toBeNull();
  });
});
