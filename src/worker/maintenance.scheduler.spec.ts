import { MaintenanceScheduler } from './maintenance.scheduler';
import { MAINTENANCE_SCHEDULES, MaintenanceJob } from './maintenance-jobs';

describe('MaintenanceScheduler', () => {
  it('upserts one scheduler per maintenance job, keyed and named by the job', async () => {
    const queue = { upsertJobScheduler: jest.fn().mockResolvedValue({}) };
    const scheduler = new MaintenanceScheduler(queue as never, { log: jest.fn() } as never);

    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(Object.values(MaintenanceJob).length);
    for (const job of Object.values(MaintenanceJob)) {
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(job, MAINTENANCE_SCHEDULES[job], { name: job });
    }
  });

  it('keeps the cadence of the former crons, in UTC', () => {
    expect(MAINTENANCE_SCHEDULES).toEqual({
      [MaintenanceJob.ExpireAbandonedOrders]: { pattern: '0 * * * *', tz: 'UTC' },
      [MaintenanceJob.SweepPayments]: { pattern: '*/5 * * * *', tz: 'UTC' },
      [MaintenanceJob.DiffPreviousDayPayments]: { pattern: '30 1 * * *', tz: 'UTC' },
      [MaintenanceJob.CheckLowStock]: { pattern: '0 */6 * * *', tz: 'UTC' },
    });
  });

  it('fails startup when Redis rejects the schedule', async () => {
    const queue = { upsertJobScheduler: jest.fn().mockRejectedValue(new Error('READONLY')) };

    await expect(
      new MaintenanceScheduler(queue as never, { log: jest.fn() } as never).onApplicationBootstrap(),
    ).rejects.toThrow('READONLY');
  });
});
