import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import {
  OTP_DAILY_SENDS_PER_ACCOUNT,
  OTP_DAILY_SENDS_PER_PHONE,
  OTP_DAILY_WINDOW_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_SECONDS,
  OtpLimit,
  otpKeys,
} from './phone-otp';

/*
 * KEYS: code, cooldown, phone daily counter, account daily counter.
 * ARGV: code hash, code TTL ms, cooldown ms, daily window ms, phone cap, account cap.
 * Returns {0, 0} when a new code replaced any earlier one, else {limit, ms until it lifts}: 1 cooldown, 2 phone daily
 * cap, 3 account daily cap. A daily window starts at its first send.
 */
const ISSUE_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return {1, redis.call('PTTL', KEYS[2])} end
if tonumber(redis.call('GET', KEYS[3]) or '0') >= tonumber(ARGV[5]) then return {2, redis.call('PTTL', KEYS[3])} end
if tonumber(redis.call('GET', KEYS[4]) or '0') >= tonumber(ARGV[6]) then return {3, redis.call('PTTL', KEYS[4])} end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'hash', ARGV[1], 'attempts', 0)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
for i = 3, 4 do
  redis.call('INCR', KEYS[i])
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], ARGV[4]) end
end
return {0, 0}
`;

/*
 * KEYS: code. ARGV: hash of the code entered, attempts allowed.
 * Returns {0, 0} on a match (the code is used up), {1, 0} when there is no live code, {2, 0} when this wrong entry
 * used the last attempt (the code is deleted), else {3, attempts left}.
 */
const VERIFY_SCRIPT = `
local stored = redis.call('HGET', KEYS[1], 'hash')
if not stored then return {1, 0} end
if stored == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {0, 0}
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {2, 0}
end
return {3, tonumber(ARGV[2]) - attempts}
`;

export type IssueOutcome = { issued: true } | { issued: false; limit: OtpLimit; retryAfterSeconds: number };

export type VerifyOutcome =
  | { result: 'MATCH' }
  | { result: 'NO_CODE' }
  | { result: 'ATTEMPTS_EXCEEDED' }
  | { result: 'MISMATCH'; attemptsLeft: number };

const LIMITS: Record<number, OtpLimit> = { 1: OtpLimit.COOLDOWN, 2: OtpLimit.PHONE_DAILY, 3: OtpLimit.ACCOUNT_DAILY };

/** One-time phone codes in Redis: hashed code with its attempt count, resend cooldown and daily send caps. */
@Injectable()
export class PhoneOtpStore {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** Stores a new code (replacing any earlier one for the account and phone) unless a limit refuses it. */
  async issue(userId: string, phone: string, codeHash: string): Promise<IssueOutcome> {
    const keys = otpKeys(userId, phone);
    const [status, ttlMs] = (await this.redis.eval(
      ISSUE_SCRIPT,
      4,
      keys.code,
      keys.cooldown,
      keys.phoneDaily,
      keys.accountDaily,
      codeHash,
      OTP_TTL_SECONDS * 1000,
      OTP_RESEND_COOLDOWN_SECONDS * 1000,
      OTP_DAILY_WINDOW_SECONDS * 1000,
      OTP_DAILY_SENDS_PER_PHONE,
      OTP_DAILY_SENDS_PER_ACCOUNT,
    )) as [number, number];
    if (status === 0) return { issued: true };
    const limit = LIMITS[status];
    if (!limit) throw new Error(`Unexpected OTP issue status ${status}`);
    return { issued: false, limit, retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)) };
  }

  async verify(userId: string, phone: string, codeHash: string): Promise<VerifyOutcome> {
    const [status, attemptsLeft] = (await this.redis.eval(
      VERIFY_SCRIPT,
      1,
      otpKeys(userId, phone).code,
      codeHash,
      OTP_MAX_ATTEMPTS,
    )) as [number, number];
    switch (status) {
      case 0:
        return { result: 'MATCH' };
      case 1:
        return { result: 'NO_CODE' };
      case 2:
        return { result: 'ATTEMPTS_EXCEEDED' };
      case 3:
        return { result: 'MISMATCH', attemptsLeft };
      default:
        throw new Error(`Unexpected OTP verify status ${status}`);
    }
  }
}
