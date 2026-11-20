import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { logFailedJob } from '../jobs/failed-job-log';
import { ExpiredOrdersTask } from '../order/tasks/expired-orders.task';
import { LowStockTask } from '../inventory/tasks/low-stock.task';
import { PaymentReconciliationTask } from '../payment/tasks/payment-reconciliation.task';
import { MaintenanceJob } from './maintenance-jobs';

const CONTEXT = 'MaintenanceProcessor';

/**
 * Runs the repeatable maintenance jobs. Each tick is one job, taken by one worker. The tasks keep their Postgres
 * advisory locks as a second guard, so an overlapping run (a slow tick, a retried job) still skips.
 */
@Processor(JobQueue.Maintenance)
export class MaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly expiredOrders: ExpiredOrdersTask,
    private readonly lowStock: LowStockTask,
    private readonly payments: PaymentReconciliationTask,
    private readonly logger: LoggerService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    switch (job.name as MaintenanceJob) {
      case MaintenanceJob.ExpireAbandonedOrders:
        return this.expiredOrders.cancelAbandonedOrders();
      case MaintenanceJob.SweepPayments:
        return this.payments.sweep();
      case MaintenanceJob.DiffPreviousDayPayments:
        return this.payments.diffPreviousDay();
      case MaintenanceJob.CheckLowStock:
        return this.lowStock.checkLowStock();
      default:
        throw new Error(`Unknown maintenance job "${job.name}"`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    logFailedJob(this.logger, CONTEXT, job, error);
  }
}
