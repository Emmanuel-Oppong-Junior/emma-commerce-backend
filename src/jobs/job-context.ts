import { randomUUID } from 'node:crypto';
import { Job } from 'bullmq';
import { currentCorrelation, isValidRequestId, runWithCorrelation } from '../commons/correlation';

/** Tracing data a job carries next to its payload; consumers ignore it. */
export interface JobMeta {
  requestId: string;
}

export type WithJobMeta<T> = T & { meta?: JobMeta };

/** The running request's id for a job queued now (undefined outside a request, e.g. a scheduled run). */
export function currentJobMeta(): JobMeta | undefined {
  const requestId = currentCorrelation()?.requestId;
  return requestId ? { requestId } : undefined;
}

/** `data` plus the originating request id, when there is one. */
export function withJobMeta<T extends object>(data: T): WithJobMeta<T> {
  const meta = currentJobMeta();
  return meta ? { ...data, meta } : data;
}

function originatingRequestId(job: Job): string | undefined {
  const data: unknown = job.data;
  if (typeof data !== 'object' || data === null || !('meta' in data)) return undefined;
  const meta: unknown = data.meta;
  if (typeof meta !== 'object' || meta === null || !('requestId' in meta)) return undefined;
  return isValidRequestId(meta.requestId) ? meta.requestId : undefined;
}

/**
 * Runs `work` in the job's correlation context: the request id that queued it (scheduled jobs get a new one), the job
 * id and the queue, so every log record of the job carries them.
 */
export function runJobInContext<T>(job: Job, work: () => T): T {
  const requestId = originatingRequestId(job) ?? randomUUID();
  return runWithCorrelation({ requestId, jobId: job.id, queue: job.queueName }, work);
}
