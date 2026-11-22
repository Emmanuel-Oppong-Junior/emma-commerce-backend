import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { logFailedJob } from '../jobs/failed-job-log';
import { runJobInContext } from '../jobs/job-context';
import { reportFailedJob } from '../observability/error-reporting';
import { AppMetrics } from '../observability/metrics';
import { ExpiredOrdersTask } from '../order/tasks/expired-orders.task';
import { PaymentReconciliationTask } from '../payment/tasks/payment-reconciliation.task';
import { StockReconciliationTask } from '../inventory/tasks/stock-reconciliation.task';
import { LowStockDigestTask } from '../inventory/tasks/low-stock-digest.task';
import { MaintenanceJob } from './maintenance-jobs';

const CONTEXT = 'MaintenanceProcessor';

/**
 * Runs the repeatable maintenance jobs. Each tick is one job, taken by one worker. The tasks keep their Postgres
 * advisory locks as a second guard, so an overlapping run (a slow tick, a retried job) still skips.
 */
@Processor(JobQueue.MAINTENANCE)
export class MaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly expiredOrders: ExpiredOrdersTask,
    private readonly payments: PaymentReconciliationTask,
    private readonly stock: StockReconciliationTask,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
    private readonly lowStockDigest: LowStockDigestTask,
  ) {
    super();
  }

  process(job: Job): Promise<void> {
    return runJobInContext(job, () => this.metrics.observeJob(job, () => this.run(job)));
  }

  private async run(job: Job): Promise<void> {
    switch (job.name as MaintenanceJob) {
      case MaintenanceJob.ExpireAbandonedOrders:
        return this.expiredOrders.cancelAbandonedOrders();
      case MaintenanceJob.SweepPayments:
        return this.payments.sweep();
      case MaintenanceJob.DiffPreviousDayPayments:
        return this.payments.diffPreviousDay();
      case MaintenanceJob.ReconcileStock:
        await this.stock.reconcile();
        return;
      case MaintenanceJob.SendLowStockDigest:
        await this.lowStockDigest.send();
        return;
      default:
        throw new Error(`Unknown maintenance job "${job.name}"`);
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    logFailedJob(this.logger, CONTEXT, job, error);
    reportFailedJob(job, error);
  }
}
