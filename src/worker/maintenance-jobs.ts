import { RepeatOptions } from 'bullmq';

/** Repeatable jobs on the maintenance queue; each name is also its job scheduler id. */
export enum MaintenanceJob {
  ExpireAbandonedOrders = 'orders.expire-abandoned',
  SweepPayments = 'payments.sweep',
  DiffPreviousDayPayments = 'payments.diff-previous-day',
  ReconcileStock = 'inventory.reconcile-stock',
  SendLowStockDigest = 'inventory.low-stock-digest',
  WriteOffExpiredLots = 'inventory.expire-lots',
  PurgeNotifications = 'notifications.purge',
  RemindAbandonedCarts = 'cart.abandoned-reminders',
  PurgeGuestCarts = 'cart.purge-guest-carts',
  ExpireLoyaltyPoints = 'loyalty.expire-points',
  PurgeImports = 'imports.purge',
}

// Same cadence the in-process crons had. BullMQ creates one job per tick for the whole cluster.
export const MAINTENANCE_SCHEDULES: Record<MaintenanceJob, Omit<RepeatOptions, 'key'>> = {
  [MaintenanceJob.ExpireAbandonedOrders]: { pattern: '0 * * * *', tz: 'UTC' },
  [MaintenanceJob.SweepPayments]: { pattern: '*/5 * * * *', tz: 'UTC' },
  [MaintenanceJob.DiffPreviousDayPayments]: { pattern: '30 1 * * *', tz: 'UTC' },
  [MaintenanceJob.ReconcileStock]: { pattern: '30 2 * * *', tz: 'UTC' },
  // Every 3 hours from 06:00 UTC (Ghana time): a few emails a day instead of one per crossing.
  [MaintenanceJob.SendLowStockDigest]: { pattern: '0 6-21/3 * * *', tz: 'UTC' },
  // Hourly; placement and availability already leave expired lots out between runs.
  [MaintenanceJob.WriteOffExpiredLots]: { pattern: '5 * * * *', tz: 'UTC' },
  [MaintenanceJob.PurgeNotifications]: { pattern: '15 3 * * *', tz: 'UTC' },
  [MaintenanceJob.RemindAbandonedCarts]: { pattern: '20 * * * *', tz: 'UTC' },
  [MaintenanceJob.PurgeGuestCarts]: { pattern: '45 3 * * *', tz: 'UTC' },
  // Daily; spending and refunds expire a customer's due points themselves in between.
  [MaintenanceJob.ExpireLoyaltyPoints]: { pattern: '50 0 * * *', tz: 'UTC' },
  [MaintenanceJob.PurgeImports]: { pattern: '25 4 * * *', tz: 'UTC' },
};
