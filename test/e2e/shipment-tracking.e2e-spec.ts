import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { FulfillmentType, OrderStatus, PaymentMethod, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShipmentsService } from '../../src/order/shipments.service';
import { SmsSender } from '../../src/notifications/sms/sms-sender';
import { EmailService } from '../../src/notifications/email/email.service';
import { JobQueue } from '../../src/jobs/job-queues';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber, verifyPhoneForCod } from '../helpers/db.helper';

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

// Customer tracking (P5-B.2): the timeline on the customer's own order, and SMS milestones sent from the worker.
describe('Shipment tracking timeline and SMS milestones (P5-B.2, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let shipments: ShipmentsService;
  let sms: SmsSender;
  let userToken: string;
  let adminToken: string;
  let phoneSeq = 0;

  const createOrder = async (fulfillmentType: FulfillmentType = FulfillmentType.DELIVERY) => {
    phoneSeq += 1;
    const contactPhone = `+2332445${String(phoneSeq).padStart(5, '0')}`;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        status: OrderStatus.CONFIRMED,
        paymentMethod: PaymentMethod.ONLINE,
        fulfillmentType,
        grandTotal: 40,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone,
        statusEvents: {
          create: [
            { from: null, to: 'PLACED' },
            { from: 'PLACED', to: 'CONFIRMED' },
          ],
        },
        items: {
          create: {
            productId: 'seed_prod1',
            variantId: 'seed_var1',
            productName: 'Seed product',
            quantity: 2,
            unitListPrice: 20,
            unitDiscount: 0,
            lineTotal: 40,
          },
        },
      },
      include: { items: true },
    });
    return { orderId: order.id, orderItemId: order.items[0].id, orderNumber: order.orderNumber, contactPhone };
  };

  const gql = async (query: string, token: string) => (await gqlRequest(app, query, undefined, token).expect(200)).body;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    worker = await createTestWorker();
    shipments = worker.get(ShipmentsService);
    sms = worker.get(SmsSender);
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(worker.get(EmailService), 'sendOrderStatusEmail').mockResolvedValue();
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  it('shows the customer their own order’s timeline: order and shipment steps by time, with the tracking number', async () => {
    const sends = jest.spyOn(sms, 'send').mockResolvedValue();
    const { orderId, orderItemId } = await createOrder();
    const first = await shipments.createShipment(orderId, [{ orderItemId, quantity: 1 }], 'seed_admin');
    await shipments.updateShipping(first.id, 'TRK-9', 'DHL', 'seed_admin');
    await shipments.updateShipmentStatus(first.id, ShipmentStatus.OUT_FOR_DELIVERY, 'seed_admin', 'Rider Kofi');

    const query = `{ order(orderId: "${orderId}") { trackingTimeline { orderStatus shipmentId shipmentStatus carrier trackingNumber at } } }`;
    const own = await gql(query, userToken);

    expect(own.errors).toBeUndefined();
    const steps = own.data.order.trackingTimeline as {
      at: string;
      orderStatus: string | null;
      shipmentStatus: string | null;
    }[];
    const labels = steps.map((step) => step.orderStatus ?? step.shipmentStatus);
    // The dispatch and the order's move to IN_FULFILMENT are written in one transaction, in either order of time.
    expect(labels.slice(0, 3)).toEqual(['PLACED', 'CONFIRMED', 'PENDING']);
    expect(labels.slice(3).sort()).toEqual(['IN_FULFILMENT', 'OUT_FOR_DELIVERY']);
    const times = steps.map((step) => Date.parse(step.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(steps.find((step) => step.shipmentStatus === 'OUT_FOR_DELIVERY')).toMatchObject({
      shipmentId: first.id,
      carrier: 'DHL',
      trackingNumber: 'TRK-9',
    });
    await waitUntil(async () => sends.mock.calls.length >= 1);

    const other = (
      await signUpUser(app, { email: 'tracking-other@test.local', password: 'Str0ng!Passw0rd', name: 'Kofi Boateng' })
    ).accessToken;
    expect((await gql(query, other)).errors[0].extensions.code).toBe('NOT_FOUND');
    const staffView = await gql(`{ viewOrder(id: "${orderId}") { trackingTimeline { shipmentStatus } } }`, adminToken);
    expect(staffView.errors).toBeUndefined();
    // The step type has no actor or reason to ask for.
    const leak = await gqlRequest(
      app,
      `{ order(orderId: "${orderId}") { trackingTimeline { reason } } }`,
      undefined,
      userToken,
    );
    expect(leak.status).toBe(400);
  });

  it('texts the customer once when a shipment goes out (with carrier and tracking) and once when it is delivered', async () => {
    const sends = jest.spyOn(sms, 'send').mockResolvedValue();
    const { orderId, orderNumber, contactPhone } = await createOrder();
    const shipment = await shipments.createShipment(orderId, undefined, 'seed_admin');
    await shipments.updateShipping(shipment.id, 'TRK-1', 'DHL', 'seed_admin');

    await shipments.updateShipmentStatus(shipment.id, ShipmentStatus.OUT_FOR_DELIVERY, 'seed_admin');
    await waitUntil(async () => sends.mock.calls.length >= 1);
    expect(sends).toHaveBeenLastCalledWith(
      contactPhone,
      `Your order #${orderNumber} is out for delivery with DHL. Tracking number: TRK-1.`,
      'shipment_out_for_delivery',
    );

    await shipments.updateShipmentStatus(shipment.id, ShipmentStatus.DELIVERED, 'seed_admin');
    await waitUntil(async () => sends.mock.calls.length >= 2);
    expect(sends).toHaveBeenLastCalledWith(
      contactPhone,
      `Your order #${orderNumber} has been delivered. Thank you for shopping with us.`,
      'shipment_delivered',
    );

    // The dispatch event published again (and its job run again) sends nothing more.
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: orderId, type: 'shipment.status_changed.v1' },
      orderBy: { createdAt: 'asc' },
    });
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
    await waitUntil(async () => (await (await queue.getJob(`${event.id}-sms`))?.getState()) === 'completed');
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { publishedAt: null } });
    await waitUntil(
      async () => (await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).publishedAt !== null,
    );
    await (await queue.getJob(event.id))!.retry('completed');
    await (await queue.getJob(`${event.id}-sms`))!.retry('completed');
    await sleep(2_000);
    expect(sends).toHaveBeenCalledTimes(2);
  });

  it('prefers the verified account phone, and sends no SMS for the pickup counter', async () => {
    const sends = jest.spyOn(sms, 'send').mockResolvedValue();
    await verifyPhoneForCod(prisma, 'seed_user', '+233201234567');
    const pickup = await createOrder(FulfillmentType.PICKUP);
    const counter = await shipments.createShipment(pickup.orderId, undefined, 'seed_admin');
    await shipments.updateShipmentStatus(counter.id, ShipmentStatus.READY_FOR_PICKUP, 'seed_admin');
    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: pickup.orderId, type: 'shipment.status_changed.v1' },
    });
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
    await waitUntil(async () => (await (await queue.getJob(event.id))?.getState()) === 'completed');
    expect(await queue.getJob(`${event.id}-sms`)).toBeUndefined();
    expect(sends).not.toHaveBeenCalled();

    const delivery = await createOrder();
    const shipment = await shipments.createShipment(delivery.orderId, undefined, 'seed_admin');
    await shipments.updateShipmentStatus(shipment.id, ShipmentStatus.OUT_FOR_DELIVERY, 'seed_admin');
    await waitUntil(async () => sends.mock.calls.length >= 1);
    expect(sends.mock.calls[0][0]).toBe('+233201234567');
    expect(sends.mock.calls[0][1]).toBe(`Your order #${delivery.orderNumber} is out for delivery.`);
  });
});
