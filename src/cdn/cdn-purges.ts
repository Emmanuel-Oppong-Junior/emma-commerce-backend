import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { JobQueue } from '../jobs/job-queues';
import { DomainEventPayloads } from '../outbox/domain-events';
import { CDN_PURGER, CdnPurger } from './cdn-purger';
import { PURGE_WINDOW_MS, pendingPurge, planPurges } from './purge-plan';
import { isCatalogueChangeReason, purgeKeysFor } from './surrogate-keys';

export const PENDING_PURGES_KEY = 'cdn:purges:pending';
/** The one-off maintenance job that sends a window's purges. */
export const CDN_FLUSH_JOB = 'cdn.flush-purges';
// The flush runs a little after the window closes, so a change accepted in the window's last moment is in it.
const FLUSH_GRACE_MS = 1_000;
const FLUSH_BATCH = 10_000;

type CatalogueChange = DomainEventPayloads['catalogue.changed.v1'];

/**
 * Worker side of CDN invalidation. Each catalogue.changed.v1 adds its keys to a Redis set (durable across a worker
 * crash, and a set, so repeats collapse) and schedules one flush per window; the flush sends them through CdnPurger.
 */
@Injectable()
export class CdnPurges {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(JobQueue.MAINTENANCE) private readonly maintenance: Queue,
    @Inject(CDN_PURGER) private readonly purger: CdnPurger,
  ) {}

  async enqueue(change: unknown): Promise<void> {
    const { reason, ids } = parseChange(change);
    const keys = purgeKeysFor(reason, ids);
    await this.redis.sadd(PENDING_PURGES_KEY, ...keys.map((key) => pendingPurge(reason, key)));
    // Deduplicated for the window: the first change of a window schedules its flush, later ones join it.
    await this.maintenance.add(
      CDN_FLUSH_JOB,
      {},
      {
        delay: PURGE_WINDOW_MS + FLUSH_GRACE_MS,
        deduplication: { id: CDN_FLUSH_JOB, ttl: PURGE_WINDOW_MS },
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    );
  }

  /** Takes the pending keys and purges them; on failure they go back to the set for the retry. */
  async flush(): Promise<void> {
    for (;;) {
      const pending = await this.redis.spop(PENDING_PURGES_KEY, FLUSH_BATCH);
      if (pending.length === 0) return;
      try {
        for (const request of planPurges(pending)) await this.purger.purge(request);
      } catch (error) {
        await this.redis.sadd(PENDING_PURGES_KEY, ...pending);
        throw error;
      }
    }
  }
}

function parseChange(change: unknown): CatalogueChange {
  const { reason, ids } = (change ?? {}) as Partial<CatalogueChange>;
  const validIds = ids === null || (Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
  if (!isCatalogueChangeReason(reason) || !validIds) {
    throw new Error(`Malformed catalogue.changed.v1 payload: ${JSON.stringify(change)}`);
  }
  return { reason, ids: ids ?? null };
}
