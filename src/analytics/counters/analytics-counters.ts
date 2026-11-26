import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { LoggerService } from '../../commons/logger.service';
import { describeErrorForLog } from '../../commons/filters/error-classification';
import { dayKey, startOfUtcDay } from '../domain/report-range';

export enum AnalyticsCounter {
  CartsStarted = 'carts_started',
  CheckoutQuotes = 'checkout_quotes',
}

/** Long enough that a backfill of the last year still finds the counts; older days keep what the job copied. */
const COUNTER_TTL_SECONDS = 400 * 24 * 60 * 60;
const CONTEXT = 'AnalyticsCounters';

export function counterKey(counter: AnalyticsCounter, day: Date): string {
  return `analytics:${counter}:${dayKey(day)}`;
}

/**
 * Per-day counts of checkout steps that leave no row behind (P8-A conversion funnel): a counter per UTC day in Redis,
 * copied into AnalyticsDailySales by the rollup job. An increment that fails is logged and skipped: losing one count
 * of a funnel metric must never refuse a cart or a checkout.
 */
@Injectable()
export class AnalyticsCounters {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: LoggerService,
  ) {}

  async increment(counter: AnalyticsCounter, now = new Date()): Promise<void> {
    const key = counterKey(counter, startOfUtcDay(now));
    try {
      await this.redis.multi().incr(key).expire(key, COUNTER_TTL_SECONDS).exec();
    } catch (error) {
      this.logger.error(`Analytics counter ${counter} not counted: ${describeErrorForLog(error)}`, undefined, CONTEXT);
    }
  }

  /** The counts of each day, null for a day with no counter left in Redis (none yet, or expired). */
  async read(counter: AnalyticsCounter, days: readonly Date[]): Promise<(number | null)[]> {
    if (days.length === 0) return [];
    const values = await this.redis.mget(days.map((day) => counterKey(counter, day)));
    // eslint-disable-next-line no-restricted-syntax -- a count, not money
    return values.map((value) => (value === null ? null : Number.parseInt(value, 10)));
  }
}
