// main.ts's first import: error tracking and telemetry must start before Nest, Express, Prisma or ioredis load.
import { initSentry } from './observability/sentry';
import { startTelemetry } from './telemetry';

initSentry(process.env);

export const telemetry = startTelemetry(process.env);
