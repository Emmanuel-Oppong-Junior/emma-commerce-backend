import { toPublicProfile } from './public-profile.entity';

describe('toPublicProfile', () => {
  it.each([
    ['Kwame Asante', 'Kwame A.'],
    ['  ama   serwaa  boateng ', 'ama B.'],
    ['Kofi', 'Kofi'],
    ['', 'Customer'],
    ['   ', 'Customer'],
    [null, 'Customer'],
  ])('shows %p as %p', (name, displayName) => {
    expect(toPublicProfile({ name })).toEqual({ displayName });
  });

  it('shows a missing user as Customer', () => {
    expect(toPublicProfile(null)).toEqual({ displayName: 'Customer' });
  });

  it('never carries anything but the display name', () => {
    const profile = toPublicProfile({ name: 'Kwame Asante', email: 'k@x.test' } as { name: string });
    expect(Object.keys(profile)).toEqual(['displayName']);
  });
});
