import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LoggerService } from '../../src/commons/logger.service';
import { AllExceptionsFilter } from '../../src/commons/filters/all-exceptions.filter';
import { GqlThrottlerGuard } from '../../src/commons/guards/gql-throttler.guard';

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
 * The throttle guard is replaced with a no-op so rate-limited mutations
 * (forgotPassword, resetPassword, etc.) can be called freely within test suites.
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
    // Disable rate limiting in e2e tests — throttle behaviour is tested at the
    // unit level; having it active here would cause password-reset tests to fail
    // after three consecutive calls within the same test run.
    .overrideProvider(GqlThrottlerGuard)
    .useValue({ canActivate: () => true })
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
