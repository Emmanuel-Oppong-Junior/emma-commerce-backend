import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Ids that tie every log record of one request or job together. */
export interface Correlation {
  requestId: string;
  /** The request whose authenticated user (set later by the auth guard) is read when a record is written. */
  request?: { user?: { id?: string } };
  jobId?: string;
  queue?: string;
}

/** The fields a log record or error report carries. */
export interface CorrelationFields {
  requestId: string;
  userId?: string;
  jobId?: string;
  queue?: string;
}

// Anything else (spaces, newlines, very long values) is replaced, so a client cannot forge log lines or break the header.
export const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

const storage = new AsyncLocalStorage<Correlation>();

export function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** The client's request id when it is well formed, otherwise a new one. */
export function resolveRequestId(clientValue: unknown): string {
  return isValidRequestId(clientValue) ? clientValue : randomUUID();
}

export function runWithCorrelation<T>(correlation: Correlation, fn: () => T): T {
  return storage.run(correlation, fn);
}

/** The ids of the request or job running now, or undefined outside one (startup, the relay loop). */
export function currentCorrelation(): CorrelationFields | undefined {
  const correlation = storage.getStore();
  if (!correlation) return undefined;
  const { requestId, request, jobId, queue } = correlation;
  const userId = request?.user?.id;
  return {
    requestId,
    ...(userId ? { userId } : {}),
    ...(jobId ? { jobId } : {}),
    ...(queue ? { queue } : {}),
  };
}
