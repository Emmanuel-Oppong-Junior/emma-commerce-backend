import * as Sentry from '@sentry/nestjs';
import { Job } from 'bullmq';
import { currentCorrelation } from '../commons/correlation';
import { runJobInContext } from '../jobs/job-context';

/** Reports a server-side failure with the running request's or job's ids. A no-op when Sentry is off. */
export function reportError(exception: unknown, tags: Record<string, string | undefined> = {}): void {
  if (!Sentry.isInitialized()) return;
  const correlation = currentCorrelation();
  const allTags = { requestId: correlation?.requestId, jobId: correlation?.jobId, queue: correlation?.queue, ...tags };
  Sentry.captureException(exception, {
    tags: Object.fromEntries(Object.entries(allTags).filter(([, value]) => value !== undefined)),
    user: correlation?.userId ? { id: correlation.userId } : undefined,
  });
}

/** Reports a job that will not be retried (no attempts left) or that failed before it could be loaded. */
export function reportFailedJob(job: Job | undefined, error: Error): void {
  if (!job) return reportError(error);
  if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
  runJobInContext(job, () => reportError(error, { jobName: job.name }));
}
