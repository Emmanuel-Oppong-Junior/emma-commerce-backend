import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { setTimeout as sleep } from 'node:timers/promises';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { runWithCorrelation } from '../commons/correlation';
import { JobQueue } from '../jobs/job-queues';
import { DOMAIN_EVENT_QUEUES, DomainEventJobData, isDomainEventType } from './domain-events';

export const RELAY_BATCH_SIZE = 50;
export const RELAY_POLL_INTERVAL_MS = 1_000;
/** An event that failed to publish this many times is left unpublished with its lastError, for someone to look at. */
export const RELAY_MAX_ATTEMPTS = 10;
const RELAY_TRANSACTION_TIMEOUT_MS = 30_000;
const LAST_ERROR_MAX_LENGTH = 500;
const CONTEXT = 'OutboxRelay';

interface UnpublishedEvent {
  id: string;
  type: string;
  aggregateId: string;
  payload: Prisma.JsonValue;
  attempts: number;
  requestId: string | null;
}

/**
 * Worker-only. Moves committed outbox rows to BullMQ: locks a batch with FOR UPDATE SKIP LOCKED (so several workers
 * share the work without double-publishing), adds one job per event with jobId = event id (a repeat add is a no-op),
 * then marks the rows published in the same transaction.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly queues: Record<JobQueue, Queue>;
  private running: Promise<void> | null = null;
  private readonly stop = new AbortController();

  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
    @InjectQueue(JobQueue.NOTIFICATIONS) notifications: Queue,
    @InjectQueue(JobQueue.WEBHOOKS) webhooks: Queue,
    @InjectQueue(JobQueue.MAINTENANCE) maintenance: Queue,
    @InjectQueue(JobQueue.IMPORTS) imports: Queue,
  ) {
    this.queues = {
      [JobQueue.NOTIFICATIONS]: notifications,
      [JobQueue.WEBHOOKS]: webhooks,
      [JobQueue.MAINTENANCE]: maintenance,
      [JobQueue.IMPORTS]: imports,
    };
  }

  onApplicationBootstrap(): void {
    this.running = this.pollUntilStopped();
  }

  async onModuleDestroy(): Promise<void> {
    this.stop.abort();
    await this.running;
  }

  /** Publishes one batch of unpublished events. Returns how many were published. */
  async publishBatch(): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        const events = await tx.$queryRaw<UnpublishedEvent[]>`
          SELECT "id", "type", "aggregateId", "payload", "attempts", "requestId" FROM "OutboxEvent"
          WHERE "publishedAt" IS NULL AND "attempts" < ${RELAY_MAX_ATTEMPTS}
          ORDER BY "createdAt"
          LIMIT ${RELAY_BATCH_SIZE}
          FOR UPDATE SKIP LOCKED`;

        const published: string[] = [];
        for (const event of events) {
          try {
            await this.publish(event);
            published.push(event.id);
          } catch (error) {
            await this.recordFailure(tx, event, describeErrorForLog(error));
          }
        }
        if (published.length > 0) {
          await tx.outboxEvent.updateMany({
            where: { id: { in: published } },
            data: { publishedAt: new Date(), attempts: { increment: 1 }, lastError: null },
          });
        }
        return published.length;
      },
      { timeout: RELAY_TRANSACTION_TIMEOUT_MS },
    );
  }

  private async publish(event: UnpublishedEvent): Promise<void> {
    if (!isDomainEventType(event.type)) throw new Error(`Unknown outbox event type "${event.type}"`);
    const data: DomainEventJobData = {
      eventId: event.id,
      aggregateId: event.aggregateId,
      payload: event.payload as unknown as DomainEventJobData['payload'],
      ...(event.requestId ? { meta: { requestId: event.requestId } } : {}),
    };
    await this.queues[DOMAIN_EVENT_QUEUES[event.type]].add(event.type, data, { jobId: event.id });
  }

  private async recordFailure(tx: Prisma.TransactionClient, event: UnpublishedEvent, reason: string): Promise<void> {
    await tx.outboxEvent.update({
      where: { id: event.id },
      data: { attempts: { increment: 1 }, lastError: reason.slice(0, LAST_ERROR_MAX_LENGTH) },
    });
    const attempts = event.attempts + 1;
    const message = `Outbox event not published | id: ${event.id} | type: ${event.type} | attempts: ${attempts} | ${reason}`;
    const log = () => {
      if (attempts >= RELAY_MAX_ATTEMPTS) {
        this.logger.error(`${message} | giving up; the row stays unpublished`, undefined, CONTEXT);
      } else {
        this.logger.warn(message, CONTEXT);
      }
    };
    if (event.requestId) runWithCorrelation({ requestId: event.requestId }, log);
    else log();
  }

  private async pollUntilStopped(): Promise<void> {
    const { signal } = this.stop;
    while (!signal.aborted) {
      let published = 0;
      try {
        published = await this.publishBatch();
      } catch (error) {
        this.logger.error('Outbox relay batch failed', describeErrorForLog(error), CONTEXT);
      }
      if (published < RELAY_BATCH_SIZE) {
        await sleep(RELAY_POLL_INTERVAL_MS, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
      }
    }
  }
}
