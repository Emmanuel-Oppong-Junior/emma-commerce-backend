import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { createTestApp } from '../helpers/app.helper';

describe('Scheduled jobs in e2e apps', () => {
  let app: INestApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  afterAll(() => app.close());

  it('registers the cron jobs but leaves none running', () => {
    const jobs = [...app.get(SchedulerRegistry).getCronJobs().values()];

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.filter((job) => job.isActive)).toEqual([]);
  });
});
