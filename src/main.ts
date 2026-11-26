import { telemetry } from './instrument';
import * as Sentry from '@sentry/nestjs';
import { NestFactory } from '@nestjs/core';
import { createValidationPipe } from './commons/validation-pipe';
import { AppModule } from './app.module';
import { LoggerService } from './commons/logger.service';
import { AllExceptionsFilter } from './commons/filters/all-exceptions.filter';
import helmet from 'helmet';
import { NestExpressApplication } from '@nestjs/platform-express';
import { INestApplicationContext } from '@nestjs/common';
import { WorkerModule } from './worker/worker.module';
import { selectProcessRole } from './process-role';
import { REQUEST_ID_HEADER } from './commons/middlewares/logger.middleware';

async function bootstrapApi() {
  await telemetry?.metricsServer;
  // The Paystack webhook signature covers the exact request bytes, so the raw body is kept next to the parsed one.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  app.set('trust proxy', 1); // Trust requests from the loopback address
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false,
      // [CRITICAL-3] Explicit CSP directives — never rely on helmet's silent defaults in production
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production'
          ? {
              directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
                upgradeInsecureRequests: [],
              },
            }
          : false,
      // [MED-1] HSTS — tell browsers to always use HTTPS for this domain
      strictTransportSecurity:
        process.env.NODE_ENV === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // [MED-5] CORS — in production ALLOWED_ORIGINS must be explicitly configured.
  // Falling back to localhost in production would silently open CORS to local dev servers.
  const isProduction = process.env.NODE_ENV === 'production';
  const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
    : isProduction
      ? (() => {
          throw new Error(
            '[Security] ALLOWED_ORIGINS env var must be set in production. ' +
              'Set it to a comma-separated list of allowed origins (e.g. https://yourdomain.com).',
          );
        })()
      : ['http://localhost:3000', 'http://localhost:4000', 'http://localhost:5173', 'http://localhost:3001'];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    // apollo-require-preflight / x-apollo-operation-name: Apollo's CSRF check requires one on GET queries (APQ, CDN).
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      REQUEST_ID_HEADER,
      'apollo-require-preflight',
      'x-apollo-operation-name',
    ],
    exposedHeaders: [REQUEST_ID_HEADER],
  });

  // Custom logger
  const logger = app.get(LoggerService);
  app.useLogger(logger);

  // Global exception filter (REST)
  app.useGlobalFilters(new AllExceptionsFilter(logger));

  // Strict validation — strip unknown props and reject extra fields
  app.useGlobalPipes(createValidationPipe());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Application running on port ${port}`, 'Bootstrap');
  closeOnSignals(app, logger);
}

/** The worker: outbox relay and queue processors, no GraphQL/HTTP API (src/worker/worker.module.ts). */
async function bootstrapWorker() {
  await telemetry?.metricsServer;
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(LoggerService);
  app.useLogger(logger);
  logger.log('Worker running', 'Bootstrap');
  closeOnSignals(app, logger);
}

const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

// Graceful shutdown: app.close() lets jobs in flight finish, then closes queues, Redis and Prisma.
function closeOnSignals(app: INestApplicationContext, logger: LoggerService) {
  const shutdown = async (signal: string) => {
    logger.log(`${signal} received — closing application gracefully`, 'Bootstrap');
    await app.close();
    await telemetry?.sdk.shutdown();
    await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const role = selectProcessRole(process.env.ROLE, process.argv);
void (role === 'worker' ? bootstrapWorker() : bootstrapApi());
