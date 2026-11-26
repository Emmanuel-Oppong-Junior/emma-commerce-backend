import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { BatchObservableCallback, Meter, ObservableGauge } from '@opentelemetry/api';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { JobQueue } from '../jobs/job-queues';
import { METER } from '../observability/metrics';

export const OBSERVED_JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
const CONTEXT = 'QueueMetrics';

/**
 * Worker-only gauges read at scrape time: BullMQ job counts per queue and state, and the outbox backlog (unpublished
 * rows and the age of the oldest). A failed read is logged and leaves that scrape without the gauge.
 */
@Injectable()
export class QueueMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly queues: Queue[];
  private readonly jobs: ObservableGauge;
  private readonly outboxBacklog: ObservableGauge;
  private readonly outboxOldestAge: ObservableGauge;
  private readonly callback: BatchObservableCallback = (result) => this.observe(result);

  constructor(
    @Inject(METER) private readonly meter: Meter,
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    @InjectQueue(JobQueue.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(JobQueue.WEBHOOKS) webhooks: Queue,
    @InjectQueue(JobQueue.MAINTENANCE) maintenance: Queue,
    @InjectQueue(JobQueue.IMPORTS) imports: Queue,
  ) {
    this.queues = [notifications, webhooks, maintenance, imports];
    this.jobs = meter.createObservableGauge('queue_jobs', { description: 'BullMQ jobs per queue and state' });
    this.outboxBacklog = meter.createObservableGauge('outbox_unpublished_events', {
      description: 'Outbox rows not yet published to a queue',
    });
    this.outboxOldestAge = meter.createObservableGauge('outbox_oldest_unpublished_age_seconds', {
      description: 'Age of the oldest unpublished outbox row (0 when none)',
      unit: 's',
    });
  }

  onModuleInit(): void {
    this.meter.addBatchObservableCallback(this.callback, [this.jobs, this.outboxBacklog, this.outboxOldestAge]);
  }

  onModuleDestroy(): void {
    this.meter.removeBatchObservableCallback(this.callback, [this.jobs, this.outboxBacklog, this.outboxOldestAge]);
  }

  async observe(result: Parameters<BatchObservableCallback>[0]): Promise<void> {
    await Promise.all([this.observeQueues(result), this.observeOutbox(result)]);
  }

  private async observeQueues(result: Parameters<BatchObservableCallback>[0]): Promise<void> {
    try {
      const counts = await Promise.all(this.queues.map((queue) => queue.getJobCounts(...OBSERVED_JOB_STATES)));
      this.queues.forEach((queue, index) => {
        for (const state of OBSERVED_JOB_STATES) {
          result.observe(this.jobs, counts[index][state] ?? 0, { queue: queue.name, state });
        }
      });
    } catch (error) {
      this.logger.warn(`Queue job counts unavailable for metrics | ${describeErrorForLog(error)}`, CONTEXT);
    }
  }

  private async observeOutbox(result: Parameters<BatchObservableCallback>[0]): Promise<void> {
    try {
      const backlog = await this.prisma.outboxEvent.aggregate({
        where: { publishedAt: null },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const oldest = backlog._min.createdAt;
      result.observe(this.outboxBacklog, backlog._count._all);
      result.observe(this.outboxOldestAge, oldest ? Math.max(0, (Date.now() - oldest.getTime()) / 1000) : 0);
    } catch (error) {
      this.logger.warn(`Outbox backlog unavailable for metrics | ${describeErrorForLog(error)}`, CONTEXT);
    }
  }
}
