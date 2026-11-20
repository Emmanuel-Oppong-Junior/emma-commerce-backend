import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { redisConnectionOptions } from '../redis/redis.module';
import { JOB_QUEUE_DEFAULTS, JobQueue } from './job-queues';

/**
 * BullMQ connection and the queues, as producers. Both roles import it; only the worker registers processors, so the
 * API never consumes jobs.
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ connection: redisConnectionOptions(config) }),
    }),
    BullModule.registerQueue(
      ...Object.values(JobQueue).map((name) => ({ name, defaultJobOptions: JOB_QUEUE_DEFAULTS[name] })),
    ),
  ],
  exports: [BullModule],
})
export class JobsModule {}
