import { Inject, Injectable } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';

export const THROTTLE_KEY_PREFIX = 'throttle';

/*
 * One atomic step per request, so every instance counts against the same window.
 * KEYS[1] hit counter, KEYS[2] block marker (holds the hit count that caused the block).
 * ARGV ttl, limit, blockDuration, all in milliseconds. Returns {totalHits, hitsPttl, blocked, blockPttl}.
 * Mirrors @nestjs/throttler 6's in-memory storage: while blocked no hits are counted, and once the block ends
 * counting starts again from zero; with blockDuration <= 0 a request over the limit is refused until the window ends.
 */
const INCREMENT_SCRIPT = `
local blockPttl = redis.call('PTTL', KEYS[2])
if blockPttl > 0 then
  return {tonumber(redis.call('GET', KEYS[2])), math.max(redis.call('PTTL', KEYS[1]), 0), 1, blockPttl}
end
local ttl = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local blockDuration = tonumber(ARGV[3])
local hits = redis.call('INCR', KEYS[1])
local hitsPttl = redis.call('PTTL', KEYS[1])
if hitsPttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ttl)
  hitsPttl = ttl
end
if hits <= limit then
  return {hits, hitsPttl, 0, 0}
end
if blockDuration > 0 then
  redis.call('SET', KEYS[2], hits, 'PX', blockDuration)
  redis.call('DEL', KEYS[1])
  return {hits, hitsPttl, 1, blockDuration}
end
return {hits, hitsPttl, 1, hitsPttl}
`;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const toSeconds = (ms: number) => Math.ceil(ms / 1000);

/** Throttler storage shared by every API instance through Redis (PLAT-04). */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `${THROTTLE_KEY_PREFIX}:${throttlerName}:${key}`;
    const [totalHits, hitsPttl, blocked, blockPttl] = (await this.redis.eval(
      INCREMENT_SCRIPT,
      2,
      `${base}:hits`,
      `${base}:blocked`,
      ttl,
      limit,
      blockDuration,
    )) as [number, number, number, number];
    return {
      totalHits,
      timeToExpire: toSeconds(hitsPttl),
      isBlocked: blocked === 1,
      timeToBlockExpire: blocked === 1 ? toSeconds(blockPttl) : 0,
    };
  }
}
