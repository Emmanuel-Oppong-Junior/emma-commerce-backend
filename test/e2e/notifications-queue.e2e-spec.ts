import { INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderStatus, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShipmentsService } from '../../src/order/shipments.service';
import { EmailService } from '../../src/notifications/email/email.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { JobQueue } from '../../src/jobs/job-queues';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

// Emails go out from the worker: state change + outbox event in one transaction, relay, notifications queue.
// EmailService is the fake transport here: its send methods are spied on.
describe('Notification emails through the outbox and queue (e2e)', () => {
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let email: EmailService;
  let orderCount = 0;

  const createOrder = async (status: OrderStatus = OrderStatus.CONFIRMED) => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        status,
        grandTotal: 120,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324450${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };

  // The orders here have no lines, so their shipment is written directly rather than through createShipment.
  const createShipment = async (orderId: string) => (await prisma.shipment.create({ data: { orderId } })).id;

  const shipmentEvent = (orderId: string) =>
    prisma.outboxEvent.findFirstOrThrow({ where: { type: 'shipment.tracking_updated.v1', aggregateId: orderId } });

  beforeAll(async () => {
    worker = await createTestWorker();
    prisma = worker.get(PrismaService);
    email = worker.get(EmailService);
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
  });

  it('sends the shipment email once, keyed by the outbox event id, after the update commits', async () => {
    const sends = jest.spyOn(email, 'send').mockResolvedValue({ messageId: 'em-1' });
    const orderId = await createOrder();
    const { orderNumber } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    await worker.get(ShipmentsService).updateShipping(await createShipment(orderId), 'TRK-1', 'DHL', 'seed_admin');

    const event = await shipmentEvent(orderId);
    await waitUntil(async () => sends.mock.calls.length > 0);
    expect(sends).toHaveBeenCalledWith(
      'user@example.com',
      expect.objectContaining({
        subject: `Your order #${orderNumber} has shipped`,
        text: expect.stringContaining('Tracking number: TRK-1') as unknown,
      }),
      event.id,
    );
    const row = await prisma.notification.findUniqueOrThrow({ where: { dedupeKey: `${event.id}:EMAIL` } });
    expect(row).toMatchObject({
      userId: 'seed_user',
      templateKey: 'shipment.dispatched',
      category: 'TRANSACTIONAL',
      channel: 'EMAIL',
      status: 'SENT',
      providerMessageId: 'em-1',
      attempts: 1,
    });
    const job = await getQueue(worker, JobQueue.NOTIFICATIONS).getJob(event.id);
    await waitUntil(async () => (await job!.getState()) === 'completed');
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('does not email twice when the event is published again or its job runs again', async () => {
    const sends = jest.spyOn(email, 'send').mockResolvedValue({ messageId: 'em-2' });
    const orderId = await createOrder();
    await worker.get(ShipmentsService).updateShipping(await createShipment(orderId), 'TRK-2', 'DHL', 'seed_admin');
    const event = await shipmentEvent(orderId);
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
    await waitUntil(async () => (await (await queue.getJob(event.id))?.getState()) === 'completed');

    await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: null } });
    await waitUntil(
      async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt !== null,
    );
    await (await queue.getJob(event.id))!.retry('completed');
    await waitUntil(async () => (await (await queue.getJob(event.id))?.getState()) === 'completed');

    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('writes no event and sends nothing when the state change fails', async () => {
    const sends = jest.spyOn(email, 'send').mockResolvedValue({ messageId: 'em-3' });
    const orderId = await createOrder(OrderStatus.CANCELLED);
    const shipmentId = await createShipment(orderId);

    await expect(
      worker.get(ShipmentsService).updateShipmentStatus(shipmentId, ShipmentStatus.OUT_FOR_DELIVERY, 'seed_admin'),
    ).rejects.toThrow('only CONFIRMED or IN_FULFILMENT orders can be fulfilled');
    await sleep(1_500);

    expect(await prisma.outboxEvent.count({ where: { aggregateId: orderId } })).toBe(0);
    expect(sends).not.toHaveBeenCalled();
  });

  it('retries a failed send with backoff until it is delivered', async () => {
    const sends = jest
      .spyOn(email, 'send')
      .mockRejectedValueOnce(new Error('Email not delivered: Welcome | rate_limit_exceeded'))
      .mockResolvedValue({ messageId: 'em-4' });

    worker.get(NotificationsService).sendWelcomeEmail('seed_user', 'user@example.com', 'Regular User');

    await waitUntil(async () => sends.mock.calls.length >= 2);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(sends.mock.calls[0][2]).toBe(sends.mock.calls[1][2]);
    // One row for the message: FAILED after the first attempt, then SENT on the retry.
    await waitUntil(async () =>
      (await prisma.notification.findMany({ where: { templateKey: 'account.welcome' } })).some(
        (n) => n.status === 'SENT',
      ),
    );
    const rows = await prisma.notification.findMany({ where: { templateKey: 'account.welcome' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SENT', attempts: 2, errorCode: null, providerMessageId: 'em-4' });
  });
});
