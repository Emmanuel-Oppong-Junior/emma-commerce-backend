// main.ts's first import: error tracking and telemetry must start before Nest, Express, Prisma or ioredis load.
import { initSentry } from './observability/sentry';
import { startTracing } from './tracing';

initSentry(process.env);

export const tracingSdk = startTracing(process.env);
