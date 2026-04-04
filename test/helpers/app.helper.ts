import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AllExceptionsFilter } from '../../src/commons/filters/all-exceptions.filter';
import { ThrottlerStorage } from '@nestjs/throttler';

/**
 * A no-op ThrottlerStorage implementation.
 * Always reports `totalHits: 1, isBlocked: false`, which means the real
 * ThrottlerGuard will process every request without ever blocking it.
 * This is the most reliable way to disable rate-limiting in e2e tests because
 * it operates below the guard layer and does not require overriding an
 * APP_GUARD multi-provider slot.
 */
const noopThrottlerStorage = {
  increment: async () => ({ totalHits: 1, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
  storage: {},
};

/** The resolved shape returned by `createTestApp`. */
export interface TestApp {
  /** The fully initialised NestJS application, ready for supertest requests. */
  app: INestApplication;
  /** The Prisma client bound to the test module — use for direct DB assertions. */
  prisma: PrismaService;
}

/**
 * Bootstraps the full NestJS application for e2e testing.
 *
 * Mirrors the setup in `main.ts` (validation pipe, exception filter, logger)
 * while omitting HTTP-server concerns irrelevant to tests (Helmet, CORS).
 *
 * Rate limiting is disabled by replacing the ThrottlerStorage with a no-op
 * implementation that always reports zero hits, so no request is ever blocked
 * regardless of how many times a given operation is called.
 *
 * @example
 * ```ts
 * let app: INestApplication;
 * let prisma: PrismaService;
 *
 * beforeAll(async () => {
 *   ({ app, prisma } = await createTestApp());
 * });
 *
 * afterAll(() => app.close());
 * ```
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ThrottlerStorage)
    .useValue(noopThrottlerStorage)
    .compile();

  const app = moduleFixture.createNestApplication();
  const prisma = moduleFixture.get<PrismaService>(PrismaService);
  const logger = moduleFixture.get<LoggerService>(LoggerService);

  app.useLogger(logger);
  app.useGlobalFilters(new AllExceptionsFilter(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();

  return { app, prisma };
}
