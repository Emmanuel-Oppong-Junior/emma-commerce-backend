import { MaintenanceScheduler } from './maintenance.scheduler';
import { MAINTENANCE_SCHEDULES, MaintenanceJob } from './maintenance-jobs';

describe('MaintenanceScheduler', () => {
  it('upserts one scheduler per maintenance job, keyed and named by the job', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({}),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
    };
    const scheduler = new MaintenanceScheduler(queue as never, { log: jest.fn() } as never);

    await scheduler.onApplicationBootstrap();

    expect(queue.upsertJobScheduler).toHaveBeenCalledTimes(Object.values(MaintenanceJob).length);
    for (const job of Object.values(MaintenanceJob)) {
      expect(queue.upsertJobScheduler).toHaveBeenCalledWith(job, MAINTENANCE_SCHEDULES[job], { name: job });
    }
  });

  it('removes the schedule of a retired job, so no processor is handed ticks it does not know', async () => {
    const queue = {
      upsertJobScheduler: jest.fn().mockResolvedValue({}),
      getJobSchedulers: jest
        .fn()
        .mockResolvedValue([{ key: MaintenanceJob.SweepPayments }, { key: 'inventory.check-low-stock' }]),
      removeJobScheduler: jest.fn().mockResolvedValue(true),
    };

    await new MaintenanceScheduler(queue as never, { log: jest.fn() } as never).onApplicationBootstrap();

    expect(queue.removeJobScheduler).toHaveBeenCalledTimes(1);
    expect(queue.removeJobScheduler).toHaveBeenCalledWith('inventory.check-low-stock');
  });

  it('keeps the cadence of the former crons, in UTC', () => {
    expect(MAINTENANCE_SCHEDULES).toEqual({
      [MaintenanceJob.ExpireAbandonedOrders]: { pattern: '0 * * * *', tz: 'UTC' },
      [MaintenanceJob.SweepPayments]: { pattern: '*/5 * * * *', tz: 'UTC' },
      [MaintenanceJob.DiffPreviousDayPayments]: { pattern: '30 1 * * *', tz: 'UTC' },
      [MaintenanceJob.ReconcileStock]: { pattern: '30 2 * * *', tz: 'UTC' },
      [MaintenanceJob.SendLowStockDigest]: { pattern: '0 6-21/3 * * *', tz: 'UTC' },
      [MaintenanceJob.WriteOffExpiredLots]: { pattern: '5 * * * *', tz: 'UTC' },
      [MaintenanceJob.PurgeNotifications]: { pattern: '15 3 * * *', tz: 'UTC' },
      [MaintenanceJob.RemindAbandonedCarts]: { pattern: '20 * * * *', tz: 'UTC' },
      [MaintenanceJob.PurgeGuestCarts]: { pattern: '45 3 * * *', tz: 'UTC' },
      [MaintenanceJob.ExpireLoyaltyPoints]: { pattern: '50 0 * * *', tz: 'UTC' },
      [MaintenanceJob.PurgeImports]: { pattern: '25 4 * * *', tz: 'UTC' },
      [MaintenanceJob.RollupAnalytics]: { pattern: '*/15 * * * *', tz: 'UTC' },
    });
  });

  it('fails startup when Redis rejects the schedule', async () => {
    const queue = { upsertJobScheduler: jest.fn().mockRejectedValue(new Error('READONLY')) };

    await expect(
      new MaintenanceScheduler(queue as never, { log: jest.fn() } as never).onApplicationBootstrap(),
    ).rejects.toThrow('READONLY');
  });
});
