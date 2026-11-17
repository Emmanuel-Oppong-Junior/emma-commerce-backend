import { REDACTED, sanitizeVariables } from './useful-functions';

describe('sanitizeVariables', () => {
  it('redacts every value at any depth and keeps the keys', () => {
    const variables = {
      input: { email: 'kwame@test.local', password: 'Sup3rSecret!', address: { street: '12 Private Road' } },
      first: 20,
      ids: ['a', 'b'],
      flag: true,
      missing: null,
    };

    expect(sanitizeVariables(variables)).toEqual({
      input: { email: REDACTED, password: REDACTED, address: { street: REDACTED } },
      first: REDACTED,
      ids: [REDACTED, REDACTED],
      flag: REDACTED,
      missing: REDACTED,
    });
  });

  it('returns an empty object for no variables', () => {
    expect(sanitizeVariables({})).toEqual({});
  });
});
