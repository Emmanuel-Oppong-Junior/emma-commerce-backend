import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { MAINTENANCE_SCHEDULES, MaintenanceJob } from './maintenance-jobs';

/**
 * Worker-only. Upserts the maintenance job schedulers in Redis at startup. Upserting is idempotent, so every worker
 * instance can do it and the cluster still gets one job per tick.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(JobQueue.MAINTENANCE) private readonly queue: Queue,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const job of Object.values(MaintenanceJob)) {
      await this.queue.upsertJobScheduler(job, MAINTENANCE_SCHEDULES[job], { name: job });
    }
    this.logger.log(`Maintenance schedules registered: ${Object.values(MaintenanceJob).join(', ')}`, 'Maintenance');
  }
}
