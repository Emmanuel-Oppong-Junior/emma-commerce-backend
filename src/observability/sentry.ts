import * as Sentry from '@sentry/nestjs';
import type { Event, EventHint, NodeOptions } from '@sentry/nestjs';

// Loaded first by src/instrument.ts, before Nest, Express or Prisma: keep its imports to the Sentry SDK.

/**
 * Sentry options from the environment, or undefined when SENTRY_DSN is unset (Sentry stays off: local, test, CI).
 * Runs before config validation (it must start before the app), so env.validation.ts re-checks the same variables.
 */
export function sentryOptions(env: NodeJS.ProcessEnv): NodeOptions | undefined {
  if (!env.SENTRY_DSN) return undefined;
  return {
    dsn: env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV,
    release: env.SENTRY_RELEASE,
    tracesSampleRate: Number(env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // SDK 11 replaced `sendDefaultPii` with per-category switches: collect no personal or request data at all.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
    // The SDK's default only warns; keep Node's behaviour of exiting, so a failed bootstrap does not leave a zombie.
    integrations: [Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })],
  };
}

/** Starts Sentry when SENTRY_DSN is set. Called once per process, before the Nest app is created. */
export function initSentry(env: NodeJS.ProcessEnv): boolean {
  const options = sentryOptions(env);
  if (!options) return false;
  Sentry.init(options);
  return true;
}

/**
 * Keeps an event free of PII: the request is reduced to method and path (no body, headers, cookies, query string or
 * IP), the user to its id, breadcrumbs (which can mix in other requests' activity) are dropped, and a Prisma error's
 * message (which can quote the values written) is replaced by its code and target.
 */
export function scrubEvent<T extends Event>(event: T, hint: EventHint): T {
  if (event.request) {
    event.request = { method: event.request.method, url: event.request.url?.split('?')[0] };
  }
  event.user = event.user?.id === undefined ? undefined : { id: String(event.user.id) };
  delete event.breadcrumbs;
  const prismaCode = prismaErrorCode(hint.originalException);
  if (prismaCode !== undefined) {
    for (const exception of event.exception?.values ?? []) exception.value = `Prisma error ${prismaCode}`.trim();
  }
  return event;
}

// Matched by name: importing the Prisma client here would load it before instrumentation starts.
function prismaErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.name.startsWith('PrismaClient')) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}
