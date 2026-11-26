import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Job, Queue } from 'bullmq';
import { AuditService } from '../commons/audit.service';
import { JobQueue } from './job-queues';
import { FailedJob } from './entities/failed-job.entity';

const FAILED_REASON_MAX_LENGTH = 500;
const EMAIL_PATTERN = /[^\s@<>"'()[\]]+@[^\s@<>"'()[\]]+\.[a-z]{2,}/gi;

/** Errors are written to avoid PII; masking addresses here is the second guard before they leave the server. */
export function sanitizeFailedReason(reason: string | undefined): string {
  return (reason ?? '').replace(EMAIL_PATTERN, '[email]').slice(0, FAILED_REASON_MAX_LENGTH);
}

export function toFailedJob(queue: JobQueue, job: Job): FailedJob {
  return {
    queue,
    id: String(job.id),
    name: job.name,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    failedReason: sanitizeFailedReason(job.failedReason),
    createdAt: new Date(job.timestamp),
    failedAt: job.finishedOn ? new Date(job.finishedOn) : null,
  };
}

/** Failed-job visibility for operators: list a queue's failed set and send one job back for another full run. */
@Injectable()
export class FailedJobsService {
  private readonly queues: Record<JobQueue, Queue>;

  constructor(
    private readonly auditService: AuditService,
    @InjectQueue(JobQueue.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(JobQueue.WEBHOOKS) webhooks: Queue,
    @InjectQueue(JobQueue.MAINTENANCE) maintenance: Queue,
    @InjectQueue(JobQueue.IMPORTS) imports: Queue,
  ) {
    this.queues = {
      [JobQueue.NOTIFICATIONS]: notifications,
      [JobQueue.WEBHOOKS]: webhooks,
      [JobQueue.MAINTENANCE]: maintenance,
      [JobQueue.IMPORTS]: imports,
    };
  }

  async list(queue: JobQueue, first: number, actorId: string): Promise<FailedJob[]> {
    const jobs = await this.queues[queue].getFailed(0, first - 1);
    await this.auditService.log({
      entity: 'FailedJob',
      entityId: queue,
      action: 'VIEW',
      userId: actorId,
      details: { count: jobs.length },
    });
    return jobs.map((job) => toFailedJob(queue, job));
  }

  /**
   * Moves a failed job back to waiting with its attempt count reset, so it gets its full retries again. Consumers
   * are idempotent on the job id, so an email that did go out is not sent twice.
   * @throws NotFoundException if the job does not exist; ConflictException if it is not in the failed set.
   */
  async retry(queue: JobQueue, jobId: string, actorId: string): Promise<FailedJob> {
    const job = await this.queues[queue].getJob(jobId);
    if (!job) throw new NotFoundException(`Job "${jobId}" not found in queue ${queue}`);
    const state = await job.getState();
    if (state !== 'failed') throw new ConflictException(`Job "${jobId}" is ${state}; only failed jobs can be retried`);

    const failed = toFailedJob(queue, job);
    await job.retry('failed', { resetAttemptsMade: true });
    await this.auditService.log({
      entity: 'FailedJob',
      entityId: `${queue}:${jobId}`,
      action: 'RETRY',
      userId: actorId,
      details: { name: job.name, attemptsMade: failed.attemptsMade },
    });
    return failed;
  }
}
