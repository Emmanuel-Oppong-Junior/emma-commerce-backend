import { INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderStatus, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
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
    const sends = jest.spyOn(email, 'sendOrderStatusEmail').mockResolvedValue();
    const orderId = await createOrder();

    await worker.get(OrdersService).updateShipping(orderId, 'TRK-1', 'DHL', 'seed_admin');

    const event = await shipmentEvent(orderId);
    await waitUntil(async () => sends.mock.calls.length > 0);
    expect(sends).toHaveBeenCalledWith('user@example.com', orderId, 'SHIPPED', 'TRK-1', event.id);
    const job = await getQueue(worker, JobQueue.NOTIFICATIONS).getJob(event.id);
    await waitUntil(async () => (await job!.getState()) === 'completed');
    expect(sends).toHaveBeenCalledTimes(1);
  });

  it('does not email twice when the event is published again or its job runs again', async () => {
    const sends = jest.spyOn(email, 'sendOrderStatusEmail').mockResolvedValue();
    const orderId = await createOrder();
    await worker.get(OrdersService).updateShipping(orderId, 'TRK-2', 'DHL', 'seed_admin');
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
    const sends = jest.spyOn(email, 'sendOrderStatusEmail').mockResolvedValue();
    const orderId = await createOrder(OrderStatus.CANCELLED);

    await expect(
      worker.get(OrdersService).updateShipmentStatus(orderId, ShipmentStatus.OUT_FOR_DELIVERY, 'seed_admin'),
    ).rejects.toThrow('only CONFIRMED or IN_FULFILMENT orders can be fulfilled');
    await sleep(1_500);

    expect(await prisma.outboxEvent.count({ where: { aggregateId: orderId } })).toBe(0);
    expect(sends).not.toHaveBeenCalled();
  });

  it('retries a failed send with backoff until it is delivered', async () => {
    const sends = jest
      .spyOn(email, 'sendWelcomeEmail')
      .mockRejectedValueOnce(new Error('Email not delivered: Welcome | rate_limit_exceeded'))
      .mockResolvedValue();

    worker.get(NotificationsService).sendWelcomeEmail('user@example.com', 'Regular User');

    await waitUntil(async () => sends.mock.calls.length >= 2);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(sends.mock.calls[0][2]).toBe(sends.mock.calls[1][2]);
  });
});
