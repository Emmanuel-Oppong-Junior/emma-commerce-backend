import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ImportJobStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { logFailedJob } from '../jobs/failed-job-log';
import { runJobInContext } from '../jobs/job-context';
import { reportFailedJob } from '../observability/error-reporting';
import { AppMetrics } from '../observability/metrics';
import { ImportValidator } from './import-validator';
import { ImportApplier } from './import-applier';
import { IMPORT_APPLY_JOB, IMPORT_VALIDATE_JOB, ImportQueueJobData } from './import-queue';

const CONTEXT = 'ImportsProcessor';

/** Runs import validation and apply jobs (worker only). A job with no attempts left fails its import job. */
@Processor(JobQueue.IMPORTS)
export class ImportsProcessor extends WorkerHost {
  constructor(
    private readonly validator: ImportValidator,
    private readonly applier: ImportApplier,
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
  ) {
    super();
  }

  process(job: Job<ImportQueueJobData>): Promise<void> {
    return runJobInContext(job, () =>
      this.metrics.observeJob(job, async () => {
        if (job.name === IMPORT_VALIDATE_JOB) return this.validator.validate(job.data.importJobId);
        if (job.name === IMPORT_APPLY_JOB) return this.applier.apply(job.data.importJobId);
        throw new Error(`Unknown import job "${job.name}"`);
      }),
    );
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<ImportQueueJobData> | undefined, error: Error): Promise<void> {
    logFailedJob(this.logger, CONTEXT, job, error);
    reportFailedJob(job, error);
    if (!job || job.attemptsMade < (job.opts.attempts ?? 1)) return;
    await this.prisma.importJob.updateMany({
      where: {
        id: job.data.importJobId,
        status: { in: [ImportJobStatus.QUEUED, ImportJobStatus.VALIDATING, ImportJobStatus.APPLYING] },
      },
      data: {
        status: ImportJobStatus.FAILED,
        error: `The ${job.name === IMPORT_APPLY_JOB ? 'apply' : 'validation'} run failed after ${job.attemptsMade} attempt(s); rows already applied stay applied`,
        file: null,
      },
    });
  }
}
