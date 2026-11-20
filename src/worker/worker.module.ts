import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform.module';
import { CommonsModule } from '../commons/commons.module';
import { OutboxRelay } from '../outbox/outbox.relay';
import { WorkerHealthServer } from './worker-health.server';

/**
 * Root module of the `ROLE=worker` process: the outbox relay and the queue processors. It has no GraphQL or HTTP
 * API (only the health endpoints). Processors are registered here and nowhere else, so the API never consumes jobs.
 */
@Module({
  imports: [PlatformModule, CommonsModule],
  providers: [OutboxRelay, WorkerHealthServer],
})
export class WorkerModule {}
