import { RepeatOptions } from 'bullmq';

/** Repeatable jobs on the maintenance queue; each name is also its job scheduler id. */
export enum MaintenanceJob {
  ExpireAbandonedOrders = 'orders.expire-abandoned',
  SweepPayments = 'payments.sweep',
  DiffPreviousDayPayments = 'payments.diff-previous-day',
  ReconcileStock = 'inventory.reconcile-stock',
}

// Same cadence the in-process crons had. BullMQ creates one job per tick for the whole cluster.
export const MAINTENANCE_SCHEDULES: Record<MaintenanceJob, Omit<RepeatOptions, 'key'>> = {
  [MaintenanceJob.ExpireAbandonedOrders]: { pattern: '0 * * * *', tz: 'UTC' },
  [MaintenanceJob.SweepPayments]: { pattern: '*/5 * * * *', tz: 'UTC' },
  [MaintenanceJob.DiffPreviousDayPayments]: { pattern: '30 1 * * *', tz: 'UTC' },
  [MaintenanceJob.ReconcileStock]: { pattern: '30 2 * * *', tz: 'UTC' },
};
