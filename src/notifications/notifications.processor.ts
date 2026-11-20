import { Inject } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.module';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { logFailedJob } from '../jobs/failed-job-log';
import { runJobInContext } from '../jobs/job-context';
import { NotificationSender } from './notification-sender';

export const SENT_MARKER_PREFIX = 'notifications:sent';
// Longer than completed jobs are kept (7 days), so a re-published event finds its marker.
const SENT_MARKER_TTL_SECONDS = 30 * 24 * 60 * 60;
const CONTEXT = 'NotificationsProcessor';

/**
 * Sends the notifications queue's emails, idempotently per job id (the outbox event id for event jobs): a job whose
 * email already went out (a retry after a later failure, a stalled job run again, an event published twice) sends
 * nothing. The marker is written only after a successful send, so a failed send is always retried.
 */
@Processor(JobQueue.NOTIFICATIONS)
export class NotificationsProcessor extends WorkerHost {
  constructor(
    private readonly sender: NotificationSender,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly logger: LoggerService,
  ) {
    super();
  }

  process(job: Job): Promise<void> {
    return runJobInContext(job, () => this.send(job));
  }

  private async send(job: Job): Promise<void> {
    const jobId = job.id;
    if (!jobId) throw new Error(`Notification job "${job.name}" has no id`);
    const marker = `${SENT_MARKER_PREFIX}:${jobId}`;
    if (await this.redis.exists(marker)) {
      this.logger.log(`Already sent, skipped | name: ${job.name} | id: ${jobId}`, CONTEXT);
      return;
    }
    await this.sender.send(job.name, job.data, jobId);
    await this.redis.set(marker, '1', 'EX', SENT_MARKER_TTL_SECONDS);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, error: Error): void {
    logFailedJob(this.logger, CONTEXT, job, error);
  }
}
