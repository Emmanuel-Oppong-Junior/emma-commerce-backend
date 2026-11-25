import { Job } from 'bullmq';
import { MaintenanceProcessor } from './maintenance.processor';
import { MaintenanceJob } from './maintenance-jobs';

function buildProcessor() {
  const expiredOrders = { cancelAbandonedOrders: jest.fn().mockResolvedValue(undefined) };
  const payments = {
    sweep: jest.fn().mockResolvedValue(undefined),
    diffPreviousDay: jest.fn().mockResolvedValue(undefined),
  };
  const stock = { reconcile: jest.fn().mockResolvedValue([]) };
  const lowStockDigest = { send: jest.fn().mockResolvedValue(null) };
  const lotExpiry = { writeOffExpired: jest.fn().mockResolvedValue(null) };
  const notificationRetention = { purge: jest.fn().mockResolvedValue(null) };
  const abandonedCarts = { run: jest.fn().mockResolvedValue(null) };
  const guestCarts = { purge: jest.fn().mockResolvedValue(0) };
  const loyaltyExpiry = { expire: jest.fn().mockResolvedValue(0) };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const processor = new MaintenanceProcessor(
    expiredOrders as never,
    payments as never,
    stock as never,
    logger as never,
    { observeJob: (_job: unknown, work: () => Promise<unknown>) => work() } as never,
    lowStockDigest as never,
    lotExpiry as never,
    notificationRetention as never,
    abandonedCarts as never,
    guestCarts as never,
    loyaltyExpiry as never,
  );
  return {
    processor,
    expiredOrders,
    payments,
    stock,
    lowStockDigest,
    lotExpiry,
    notificationRetention,
    abandonedCarts,
    guestCarts,
    loyaltyExpiry,
    logger,
  };
}

const job = (name: string) => ({ name, id: '1', queueName: 'maintenance', attemptsMade: 1, opts: {} }) as Job;

describe('MaintenanceProcessor', () => {
  it.each([
    [MaintenanceJob.ExpireAbandonedOrders, 'expiredOrders', 'cancelAbandonedOrders'],
    [MaintenanceJob.SweepPayments, 'payments', 'sweep'],
    [MaintenanceJob.DiffPreviousDayPayments, 'payments', 'diffPreviousDay'],
    [MaintenanceJob.ReconcileStock, 'stock', 'reconcile'],
    [MaintenanceJob.SendLowStockDigest, 'lowStockDigest', 'send'],
    [MaintenanceJob.WriteOffExpiredLots, 'lotExpiry', 'writeOffExpired'],
    [MaintenanceJob.PurgeNotifications, 'notificationRetention', 'purge'],
    [MaintenanceJob.RemindAbandonedCarts, 'abandonedCarts', 'run'],
    [MaintenanceJob.PurgeGuestCarts, 'guestCarts', 'purge'],
    [MaintenanceJob.ExpireLoyaltyPoints, 'loyaltyExpiry', 'expire'],
  ] as const)('runs %s through %s.%s exactly once', async (name, target, method) => {
    const built = buildProcessor();

    await built.processor.process(job(name));

    const task = built[target] as unknown as Record<string, jest.Mock>;
    expect(task[method]).toHaveBeenCalledTimes(1);
    const allCalls = [
      built.expiredOrders.cancelAbandonedOrders,
      built.payments.sweep,
      built.payments.diffPreviousDay,
      built.stock.reconcile,
      built.lowStockDigest.send,
      built.lotExpiry.writeOffExpired,
      built.notificationRetention.purge,
      built.abandonedCarts.run,
      built.guestCarts.purge,
      built.loyaltyExpiry.expire,
    ].reduce((total, mock) => total + mock.mock.calls.length, 0);
    expect(allCalls).toBe(1);
  });

  it('fails a job with an unknown name so it lands in the failed set', async () => {
    await expect(buildProcessor().processor.process(job('orders.archive'))).rejects.toThrow(
      'Unknown maintenance job "orders.archive"',
    );
  });

  it('propagates a task failure to BullMQ', async () => {
    const built = buildProcessor();
    built.payments.sweep.mockRejectedValue(new Error('Paystack unreachable'));

    await expect(built.processor.process(job(MaintenanceJob.SweepPayments))).rejects.toThrow('Paystack unreachable');
  });

  it('logs a failure on the last attempt as an error naming the job, without its data', () => {
    const built = buildProcessor();
    const failed = { ...job(MaintenanceJob.SweepPayments), data: { secret: 'x' } } as unknown as Job;

    built.processor.onFailed(failed, new Error('Paystack unreachable'));

    expect(built.logger.error).toHaveBeenCalledWith(
      'Job failed | queue: maintenance | name: payments.sweep | id: 1 | attempt: 1/1 | Paystack unreachable | no attempts left; kept in the failed set',
      undefined,
      'MaintenanceProcessor',
    );
  });
});
