import { INestApplication } from '@nestjs/common';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, getQueue } from '../helpers/worker.helper';
import { JobQueue } from '../../src/jobs/job-queues';

// CRON-06: background work must never fire inside an API (or e2e) app. It runs only in the ROLE=worker process.
describe('Background jobs in API apps', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await clearQueues(app);
  });

  afterAll(() => app.close());

  it.each(Object.values(JobQueue))('runs no worker on the %s queue', async (name) => {
    await expect(getQueue(app, name).getWorkers()).resolves.toEqual([]);
  });

  it('registers no repeatable job schedules', async () => {
    await expect(getQueue(app, JobQueue.Maintenance).getJobSchedulersCount()).resolves.toBe(0);
  });
});
