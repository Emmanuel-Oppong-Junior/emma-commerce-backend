import { INestApplicationContext } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WorkerModule } from '../../src/worker/worker.module';
import { WorkerHealthServer } from '../../src/worker/worker-health.server';
import { LoggerService } from '../../src/commons/logger.service';
import { JobQueue } from '../../src/jobs/job-queues';

/**
 * Starts the `ROLE=worker` process in-process: relay loop and queue processors run against the test database and
 * Redis. Only suites that test background work start one; API test apps never consume jobs.
 * The health server is left out so several workers can run side by side without competing for PORT.
 */
export async function createTestWorker(
  override: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<INestApplicationContext> {
  const builder = Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(WorkerHealthServer)
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
}
