import { Job } from 'bullmq';
import { LoggerService } from '../commons/logger.service';

/**
 * Logs a job failure with ids and counts only: job data can hold email addresses or tokens, so it is never logged.
 * The last attempt is an error (the job now sits in the failed set until retried); earlier ones are warnings.
 */
export function logFailedJob(logger: LoggerService, context: string, job: Job | undefined, error: Error): void {
  if (!job) {
    logger.error(`Job failed before it could be loaded | ${error.message}`, undefined, context);
    return;
  }
  const maxAttempts = job.opts.attempts ?? 1;
  const summary = `Job failed | queue: ${job.queueName} | name: ${job.name} | id: ${job.id} | attempt: ${job.attemptsMade}/${maxAttempts} | ${error.message}`;
  if (job.attemptsMade >= maxAttempts) {
    logger.error(`${summary} | no attempts left; kept in the failed set`, undefined, context);
  } else {
    logger.warn(`${summary} | will retry`, context);
  }
}
