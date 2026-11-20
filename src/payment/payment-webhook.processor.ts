import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { logFailedJob } from '../jobs/failed-job-log';
import { PAYSTACK_WEBHOOK_JOB, PaymentWebhookService, PaystackWebhookJobData } from './payment-webhook.service';

const CONTEXT = 'PaymentWebhookProcessor';

/** Processes stored Paystack webhook events (job id = WebhookEvent id); a failure is retried with backoff. */
@Processor(JobQueue.WEBHOOKS)
export class PaymentWebhookProcessor extends WorkerHost {
  constructor(
    private readonly webhooks: PaymentWebhookService,
    private readonly logger: LoggerService,
  ) {
    super();
  }

  async process(job: Job<PaystackWebhookJobData>): Promise<void> {
    if (job.name !== PAYSTACK_WEBHOOK_JOB) throw new Error(`Unknown webhook job "${job.name}"`);
    await this.webhooks.processStoredEvent(job.data.webhookEventId);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    logFailedJob(this.logger, CONTEXT, job, error);
  }
}
