import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggerService } from '../../commons/logger.service';
import { AnalyticsRollupRepository } from './analytics-rollup.repository';
import { AnalyticsCounter, AnalyticsCounters } from '../counters/analytics-counters';
import { addDays, DayRange, dayKey, daysOf, parseDay, startOfUtcDay } from '../domain/report-range';

export const ANALYTICS_ROLLUP_LOCK_KEY = 70_412_020;
/** One-off job on the maintenance queue: rebuildAnalytics enqueues it with the days to rebuild. */
export const ANALYTICS_REBUILD_JOB = 'analytics.rebuild';
/**
 * Days before today the recurring run recomputes: late events land on past days (cash collected days before it is
 * recorded, an order paid long after it was placed), refunds and restocks always on the day they happen.
 */
export const ROLLUP_RECENT_DAYS = 7;
const CHUNK_DAYS = 31;
const CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const CONTEXT = 'AnalyticsRollup';

const COUNTER_COLUMNS = [
  [AnalyticsCounter.CartsStarted, 'cartsStarted'],
  [AnalyticsCounter.CheckoutQuotes, 'checkoutQuotes'],
] as const;

export interface RebuildJobData {
  from: string;
  to: string;
}

/**
 * Builds the analytics rollups (P8-A). Each chunk of days is one transaction under a blocking advisory lock, so the
 * recurring run and a backfill never interleave on the same rows; rebuilding a day twice gives the same rows.
 */
@Injectable()
export class AnalyticsRollupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: AnalyticsRollupRepository,
    private readonly counters: AnalyticsCounters,
    private readonly logger: LoggerService,
  ) {}

  /** The recurring run: today so far and the ROLLUP_RECENT_DAYS before it. */
  async rebuildRecent(now = new Date()): Promise<void> {
    const today = startOfUtcDay(now);
    await this.rebuild({ from: addDays(today, -ROLLUP_RECENT_DAYS), to: addDays(today, 1) }, now);
  }

  /** The rebuildAnalytics job. Its data comes from Redis, so it is checked again here. */
  async rebuildJob(data: RebuildJobData, now = new Date()): Promise<void> {
    const from = parseDay(data.from);
    const to = parseDay(data.to);
    if (!from || !to || to <= from) {
      throw new Error(
        `Analytics rebuild job has an invalid range: ${JSON.stringify({ from: data.from, to: data.to })}`,
      );
    }
    await this.rebuild({ from, to }, now);
  }

  async rebuild(range: DayRange, now = new Date()): Promise<void> {
    for (let from = range.from; from < range.to; from = addDays(from, CHUNK_DAYS)) {
      const chunk = { from, to: new Date(Math.min(addDays(from, CHUNK_DAYS).getTime(), range.to.getTime())) };
      const days = daysOf(chunk);
      const counts = await Promise.all(COUNTER_COLUMNS.map(([counter]) => this.counters.read(counter, days)));
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ANALYTICS_ROLLUP_LOCK_KEY}::bigint)`;
          await this.repository.rebuild(tx, chunk, now);
          for (const [index, [, column]] of COUNTER_COLUMNS.entries()) {
            for (const [dayIndex, day] of days.entries()) {
              const count = counts[index][dayIndex];
              // A counter gone from Redis (expired) keeps the count copied while it existed.
              if (count !== null) await this.repository.setCounter(tx, column, day, count);
            }
          }
        },
        { timeout: CHUNK_TIMEOUT_MS },
      );
    }
    this.logger.log(
      `Analytics rollups rebuilt | days: ${dayKey(range.from)} to ${dayKey(addDays(range.to, -1))}`,
      CONTEXT,
    );
  }
}
