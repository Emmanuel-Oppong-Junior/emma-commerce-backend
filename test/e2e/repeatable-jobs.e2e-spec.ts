import { INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { JobQueue } from '../../src/jobs/job-queues';
import { MaintenanceJob } from '../../src/worker/maintenance-jobs';
import { LowStockTask } from '../../src/inventory/tasks/low-stock.task';

describe('Repeatable maintenance jobs across two workers (e2e)', () => {
  let first: INestApplicationContext;
  let second: INestApplicationContext;
  let runs: jest.SpyInstance[];

  beforeAll(async () => {
    first = await createTestWorker();
    await clearQueues(first);
    second = await createTestWorker();
    runs = [first, second].map((worker) =>
      jest.spyOn(worker.get(LowStockTask), 'checkLowStock').mockImplementation(() => sleep(100)),
    );
  });

  afterAll(async () => {
    await clearQueues(first);
    await Promise.all([first.close(), second.close()]);
  });

  it('runs the job body once per tick, not once per worker', async () => {
    const queue = getQueue(first, JobQueue.Maintenance);
    const connected = Date.now() + 10_000;
    while ((await queue.getWorkers()).length < 2 && Date.now() < connected) await sleep(100);
    expect((await queue.getWorkers()).length).toBe(2);

    await queue.upsertJobScheduler(
      MaintenanceJob.CheckLowStock,
      { every: 1_000 },
      { name: MaintenanceJob.CheckLowStock },
    );
    await sleep(5_500);
    await queue.removeJobScheduler(MaintenanceJob.CheckLowStock);

    const deadline = Date.now() + 10_000;
    while ((await queue.getJobCountByTypes('active', 'waiting', 'delayed')) > 0 && Date.now() < deadline)
      await sleep(100);

    const ticks = (await queue.getJobs(['completed'])).filter((job) => job.name === MaintenanceJob.CheckLowStock);
    const bodyRuns = runs.reduce((total, spy) => total + spy.mock.calls.length, 0);
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(bodyRuns).toBe(ticks.length);
    await expect(queue.getJobCountByTypes('failed')).resolves.toBe(0);
  });
});
