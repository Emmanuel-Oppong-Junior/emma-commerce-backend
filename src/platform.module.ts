import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CacheModule } from '@nestjs/cache-manager';
import { envValidationSchema } from './config/env.validation';
import { cacheConfig } from './config/cache.config';
import { RedisModule } from './redis/redis.module';
import { PrismaModule } from './prisma/prisma.module';
import { JobsModule } from './jobs/jobs.module';
import { ObservabilityModule } from './observability/observability.module';

/** Global infrastructure both processes need: validated config, Redis (cache, shared client, queues), Prisma, metrics. */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Tests get their env from .env.test only; never fall through to a developer's .env (real email, Redis).
      ignoreEnvFile: process.env.NODE_ENV === 'test',
      validationSchema: envValidationSchema,
      validationOptions: { libraryOptions: { abortEarly: false } },
    }),
    CacheModule.registerAsync(cacheConfig),
    RedisModule,
    PrismaModule,
    JobsModule,
    ObservabilityModule,
  ],
})
export class PlatformModule {}
