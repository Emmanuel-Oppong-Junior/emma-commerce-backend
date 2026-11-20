import { INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OutboxService } from '../../src/outbox/outbox.service';
import { OutboxRelay } from '../../src/outbox/outbox.relay';
import { JobQueue } from '../../src/jobs/job-queues';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';

const placed = (orderId: string) => ({ type: 'order.placed.v1' as const, aggregateId: orderId, payload: { orderId } });

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

describe('Transactional outbox and relay (e2e)', () => {
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let outbox: OutboxService;

  beforeAll(async () => {
    worker = await createTestWorker();
    prisma = worker.get(PrismaService);
    outbox = new OutboxService();
  });

  beforeEach(async () => {
    await prisma.outboxEvent.deleteMany();
    await clearQueues(worker);
  });

  afterAll(async () => {
    await prisma.outboxEvent.deleteMany();
    await clearQueues(worker);
    await worker.close();
  });

  it('writes no event when the surrounding transaction rolls back', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.record(tx, placed('order_rolled_back'));
        throw new Error('business rule failed after the event was written');
      }),
    ).rejects.toThrow('business rule failed');

    await expect(prisma.outboxEvent.count({ where: { aggregateId: 'order_rolled_back' } })).resolves.toBe(0);
  });

  it('publishes a committed event as a job whose id is the event id and marks the row published', async () => {
    const eventId = await prisma.$transaction((tx) => outbox.record(tx, placed('order_committed')));
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);

    await waitUntil(
      async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).publishedAt !== null,
    );

    const job = await queue.getJob(eventId);
    expect(job).toMatchObject({
      name: 'order.placed.v1',
      data: { eventId, aggregateId: 'order_committed', payload: { orderId: 'order_committed' } },
    });
    await expect(prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).resolves.toMatchObject({
      attempts: 1,
      lastError: null,
    });
  });

  it('adds no second job when the same event is published again (relay crashed before marking it)', async () => {
    const eventId = await prisma.$transaction((tx) => outbox.record(tx, placed('order_replayed')));
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
    await waitUntil(
      async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).publishedAt !== null,
    );

    await prisma.outboxEvent.update({ where: { id: eventId }, data: { publishedAt: null } });
    await waitUntil(
      async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: eventId } })).publishedAt !== null,
    );

    const jobs = await queue.getJobs(['waiting', 'active', 'completed', 'failed', 'delayed']);
    expect(jobs.filter((job) => job.data.eventId === eventId).map((job) => job.id)).toEqual([eventId]);
  });

  it('publishes each event exactly once when two workers relay the same backlog', async () => {
    const second = await createTestWorker();
    try {
      const backlog = 120;
      await prisma.outboxEvent.createMany({
        data: Array.from({ length: backlog }, (_, i) => ({
          type: 'order.placed.v1',
          aggregateId: `order_backlog_${i}`,
          payload: { orderId: `order_backlog_${i}` },
        })),
      });
      await Promise.all([worker.get(OutboxRelay).publishBatch(), second.get(OutboxRelay).publishBatch()]);

      await waitUntil(async () => (await prisma.outboxEvent.count({ where: { publishedAt: null } })) === 0);

      const rows = await prisma.outboxEvent.findMany({ select: { id: true, attempts: true } });
      expect(rows).toHaveLength(backlog);
      expect(rows.every((row) => row.attempts === 1)).toBe(true);
      const jobs = await getQueue(worker, JobQueue.NOTIFICATIONS).getJobs(['waiting', 'active', 'completed', 'failed']);
      expect(new Set(jobs.map((job) => job.id))).toEqual(new Set(rows.map((row) => row.id)));
    } finally {
      await second.close();
    }
  });
});
