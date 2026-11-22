import { OtpLimit, otpKeys } from './phone-otp';
import { PhoneOtpStore } from './phone-otp.store';

describe('PhoneOtpStore', () => {
  const redis = { eval: jest.fn() };
  const store = new PhoneOtpStore(redis as never);
  const keys = otpKeys('u1', '+233244123456');

  beforeEach(() => redis.eval.mockReset());

  describe('issue', () => {
    it('passes the code, cooldown and both daily counters with the TTLs and caps', async () => {
      redis.eval.mockResolvedValue([0, 0]);

      await expect(store.issue('u1', '+233244123456', 'hash')).resolves.toEqual({ issued: true });

      expect(redis.eval).toHaveBeenCalledWith(
        expect.any(String),
        4,
        keys.code,
        keys.cooldown,
        keys.phoneDaily,
        keys.accountDaily,
        'hash',
        600_000,
        60_000,
        86_400_000,
        5,
        10,
      );
    });

    it.each([
      [1, OtpLimit.COOLDOWN, 42_100, 43],
      [2, OtpLimit.PHONE_DAILY, 3_600_000, 3600],
      [3, OtpLimit.ACCOUNT_DAILY, 10, 1],
    ])('maps status %p to the %p limit with the seconds until it lifts', async (status, limit, ttlMs, seconds) => {
      redis.eval.mockResolvedValue([status, ttlMs]);

      await expect(store.issue('u1', '+233244123456', 'hash')).resolves.toEqual({
        issued: false,
        limit,
        retryAfterSeconds: seconds,
      });
    });

    it('fails on a status it does not know', async () => {
      redis.eval.mockResolvedValue([9, 0]);
      await expect(store.issue('u1', '+233244123456', 'hash')).rejects.toThrow('Unexpected OTP issue status 9');
    });
  });

  describe('verify', () => {
    it('checks the code key with 5 attempts allowed', async () => {
      redis.eval.mockResolvedValue([0, 0]);

      await expect(store.verify('u1', '+233244123456', 'hash')).resolves.toEqual({ result: 'MATCH' });

      expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, keys.code, 'hash', 5);
    });

    it.each([
      [[1, 0], { result: 'NO_CODE' }],
      [[2, 0], { result: 'ATTEMPTS_EXCEEDED' }],
      [[3, 3], { result: 'MISMATCH', attemptsLeft: 3 }],
    ])('maps %p to %p', async (reply, outcome) => {
      redis.eval.mockResolvedValue(reply);
      await expect(store.verify('u1', '+233244123456', 'hash')).resolves.toEqual(outcome);
    });
  });
});
