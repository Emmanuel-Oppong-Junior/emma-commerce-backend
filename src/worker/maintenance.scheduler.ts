import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { Queue } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { MAINTENANCE_SCHEDULES, MaintenanceJob } from './maintenance-jobs';

/**
 * Worker-only. Upserts the maintenance job schedulers in Redis at startup and removes those of jobs that no longer
 * exist (they would keep producing ticks no processor knows). Both are idempotent, so every worker instance can do it
 * and the cluster still gets one job per tick.
 */
@Injectable()
export class MaintenanceScheduler implements OnApplicationBootstrap {
  constructor(
    @InjectQueue(JobQueue.MAINTENANCE) private readonly queue: Queue,
    private readonly logger: LoggerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const current: string[] = Object.values(MaintenanceJob);
    for (const job of Object.values(MaintenanceJob)) {
      await this.queue.upsertJobScheduler(job, MAINTENANCE_SCHEDULES[job], { name: job });
    }
    for (const { key } of await this.queue.getJobSchedulers()) {
      if (current.includes(key)) continue;
      await this.queue.removeJobScheduler(key);
      this.logger.log(`Removed the schedule of retired maintenance job "${key}"`, 'Maintenance');
    }
    this.logger.log(`Maintenance schedules registered: ${Object.values(MaintenanceJob).join(', ')}`, 'Maintenance');
  }
}
