import { randomBytes } from 'node:crypto';
import { unsubscribeKey, unsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token';

const KEY = unsubscribeKey(randomBytes(32));

describe('unsubscribe tokens', () => {
  it('give back the user they were signed for', () => {
    expect(verifyUnsubscribeToken(KEY, unsubscribeToken(KEY, 'user_123'))).toBe('user_123');
  });

  it('are URL-safe', () => {
    expect(unsubscribeToken(KEY, 'ckx9user')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('refuse a token for another user, another key, or a malformed one', () => {
    const token = unsubscribeToken(KEY, 'user_123');
    const [, signature] = token.split('.');
    expect(verifyUnsubscribeToken(KEY, `${Buffer.from('user_456').toString('base64url')}.${signature}`)).toBeNull();
    expect(verifyUnsubscribeToken(unsubscribeKey(randomBytes(32)), token)).toBeNull();
    for (const bad of ['', 'abc', `${token}.x`, `${token.split('.')[0]}.`, 'a.b']) {
      expect(verifyUnsubscribeToken(KEY, bad)).toBeNull();
    }
  });
});
