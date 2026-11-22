import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';

export interface CounterIncrement {
  key: string;
  windowSeconds: number;
}

/*
 * One atomic step for every counter of an event. KEYS are the counters, ARGV[i] the window of KEYS[i] in milliseconds.
 * A counter's window starts at its first hit (the expiry is set only on a key without one), like the throttler's.
 */
const INCREMENT_SCRIPT = `
local counts = {}
for i, key in ipairs(KEYS) do
  counts[i] = redis.call('INCR', key)
  if redis.call('PTTL', key) < 0 then
    redis.call('PEXPIRE', key, ARGV[i])
  end
end
return counts
`;

/** Fixed-window event counters in Redis, shared by every API and worker instance. */
@Injectable()
export class VelocityCounter {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /** The current counts, 0 for a counter with no hits in its window. */
  async read(keys: string[]): Promise<number[]> {
    if (keys.length === 0) return [];
    const values = await this.redis.mget(...keys);
    return values.map((value) => (value === null ? 0 : Number(value)));
  }

  async increment(increments: CounterIncrement[]): Promise<number[]> {
    if (increments.length === 0) return [];
    return (await this.redis.eval(
      INCREMENT_SCRIPT,
      increments.length,
      ...increments.map(({ key }) => key),
      ...increments.map(({ windowSeconds }) => windowSeconds * 1000),
    )) as number[];
  }
}
