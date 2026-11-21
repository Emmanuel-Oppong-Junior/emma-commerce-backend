import { INestApplicationContext } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { SENT_MARKER_PREFIX } from '../../src/notifications/notifications.processor';
import { WorkerModule } from '../../src/worker/worker.module';
import { WorkerHealthServer } from '../../src/worker/worker-health.server';
import { MaintenanceScheduler } from '../../src/worker/maintenance.scheduler';
import { LoggerService } from '../../src/commons/logger.service';
import { JobQueue } from '../../src/jobs/job-queues';

/**
 * Starts the `ROLE=worker` process in-process: relay loop and queue processors run against the test database and
 * Redis. Only suites that test background work start one; API test apps never consume jobs.
 * Left out: the health server (several workers can then run side by side without competing for PORT) and the
 * production maintenance schedules (they would fire on the wall clock mid-suite); tests add the schedules they need.
 */
export async function createTestWorker(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<INestApplicationContext> {
  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(WorkerHealthServer)
    .useValue({})
    .overrideProvider(MaintenanceScheduler)
    .useValue({});
  const worker = await override(builder).compile();
  worker.useLogger(worker.get(LoggerService));
  await worker.init();
  return worker;
}

export function getQueue(app: INestApplicationContext, name: JobQueue): Queue {
  return app.get<Queue>(getQueueToken(name));
}

/** Empties every queue (waiting, delayed, completed, failed and job schedulers) so suites start from nothing. */
export async function clearQueues(app: INestApplicationContext): Promise<void> {
  for (const name of Object.values(JobQueue)) await getQueue(app, name).obliterate({ force: true });
  // obliterate restarts job ids at 1, so an earlier suite's sent marker would make a new job look already sent.
  const redis = app.get<Redis>(REDIS_CLIENT);
  const markers = await scanKeys(redis, `${SENT_MARKER_PREFIX}:*`);
  if (markers.length > 0) await redis.del(...markers);
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    keys.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return keys;
}
