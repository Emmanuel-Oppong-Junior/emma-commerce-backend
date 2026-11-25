import { NotificationCategory as Category, NotificationChannel as Channel } from '../../generated/prisma/client';
import { mayDeliver, preferenceMatrix, preferenceRefusal } from './notification-preferences';

describe('preferenceMatrix', () => {
  it('defaults transactional on (locked) and marketing off, with no in-app marketing', () => {
    expect(preferenceMatrix([])).toEqual([
      { category: 'TRANSACTIONAL', channel: 'EMAIL', enabled: true, locked: true },
      { category: 'TRANSACTIONAL', channel: 'SMS', enabled: true, locked: true },
      { category: 'TRANSACTIONAL', channel: 'IN_APP', enabled: true, locked: true },
      { category: 'MARKETING', channel: 'EMAIL', enabled: false, locked: false },
      { category: 'MARKETING', channel: 'SMS', enabled: false, locked: false },
    ]);
  });

  it('shows stored marketing choices and never a disabled transactional one', () => {
    const matrix = preferenceMatrix([
      { category: Category.MARKETING, channel: Channel.EMAIL, enabled: true },
      { category: Category.TRANSACTIONAL, channel: Channel.SMS, enabled: false },
    ]);
    expect(matrix.find((p) => p.category === 'MARKETING' && p.channel === 'EMAIL')?.enabled).toBe(true);
    expect(matrix.find((p) => p.category === 'TRANSACTIONAL' && p.channel === 'SMS')?.enabled).toBe(true);
  });
});

describe('preferenceRefusal', () => {
  it('refuses switching transactional messages off, and lets turning them on pass as a no-op', () => {
    expect(preferenceRefusal(Category.TRANSACTIONAL, Channel.EMAIL, false, true)).toBe('TRANSACTIONAL_ALWAYS_ON');
    expect(preferenceRefusal(Category.TRANSACTIONAL, Channel.SMS, true, false)).toBeNull();
  });

  it('refuses marketing in the in-app feed', () => {
    expect(preferenceRefusal(Category.MARKETING, Channel.IN_APP, true, true)).toBe('CHANNEL_NOT_AVAILABLE');
  });

  it('needs a verified phone to opt in to marketing SMS, but never to opt out', () => {
    expect(preferenceRefusal(Category.MARKETING, Channel.SMS, true, false)).toBe('PHONE_NOT_VERIFIED');
    expect(preferenceRefusal(Category.MARKETING, Channel.SMS, true, true)).toBeNull();
    expect(preferenceRefusal(Category.MARKETING, Channel.SMS, false, false)).toBeNull();
    expect(preferenceRefusal(Category.MARKETING, Channel.EMAIL, true, false)).toBeNull();
  });
});

describe('mayDeliver', () => {
  it('always delivers transactional messages, consent or not', () => {
    for (const channel of [Channel.EMAIL, Channel.SMS, Channel.IN_APP]) {
      expect(mayDeliver(Category.TRANSACTIONAL, channel, false, false)).toBe(true);
    }
  });

  it('delivers marketing only with consent for the channel, and SMS only to a verified phone', () => {
    expect(mayDeliver(Category.MARKETING, Channel.EMAIL, false, true)).toBe(false);
    expect(mayDeliver(Category.MARKETING, Channel.EMAIL, true, false)).toBe(true);
    expect(mayDeliver(Category.MARKETING, Channel.SMS, true, false)).toBe(false);
    expect(mayDeliver(Category.MARKETING, Channel.SMS, true, true)).toBe(true);
    expect(mayDeliver(Category.MARKETING, Channel.IN_APP, true, true)).toBe(false);
  });
});
