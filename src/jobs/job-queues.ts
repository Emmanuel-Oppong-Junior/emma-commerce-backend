import { DefaultJobOptions } from 'bullmq';

export enum JobQueue {
  NOTIFICATIONS = 'notifications',
  WEBHOOKS = 'webhooks',
  MAINTENANCE = 'maintenance',
  IMPORTS = 'imports',
}

const DAY_SECONDS = 24 * 60 * 60;

// Completed jobs are kept for a week so a re-add with the same jobId (outbox event id, webhook id) stays a no-op;
// failed jobs are kept for a month so they can be listed and retried.
export const JOB_QUEUE_DEFAULTS: Record<JobQueue, DefaultJobOptions> = {
  [JobQueue.NOTIFICATIONS]: {
    attempts: 6,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * DAY_SECONDS },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
  [JobQueue.WEBHOOKS]: {
    attempts: 8,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 7 * DAY_SECONDS },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
  // Repeatable jobs: the next tick is the retry.
  [JobQueue.MAINTENANCE]: {
    attempts: 1,
    removeOnComplete: { count: 200 },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
  // Bulk import validation and apply runs (P8-I); applied rows are tracked per row, so a retry skips them.
  [JobQueue.IMPORTS]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: { age: 7 * DAY_SECONDS },
    removeOnFail: { age: 30 * DAY_SECONDS },
  },
};
