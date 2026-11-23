import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ShipmentsService } from '../../src/order/shipments.service';
import { EmailService } from '../../src/notifications/email/email.service';
import { SmsSender } from '../../src/notifications/sms/sms-sender';
import { JobQueue } from '../../src/jobs/job-queues';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { shipmentOf } from '../helpers/shipment.helper';

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

const POINT = `id name region contactPhone instructions ghanaPostGps openingHours { weekday opens closes } openingHoursText`;

// P5-E.1: pickup points carry a region, contact phone, instructions and opening hours; when an order is ready at the
// counter the customer gets one email and one SMS with the point, its hours and the order number.
describe('Pickup points with hours and the ready-for-pickup notice (P5-E.1, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let adminToken: string;
  let pointId: string;

  const adminGql = (query: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, adminToken).expect(200);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    worker = await createTestWorker();
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  it('creates a point with its region, contact and hours, and shows them to customers', async () => {
    const res = await adminGql(
      `mutation($input: CreatePickupLocationInput!) { createPickupLocation(input: $input) { ${POINT} } }`,
      {
        input: {
          name: 'Osu Store',
          address: '12 Oxford St',
          city: 'Accra',
          region: 'GREATER_ACCRA',
          contactPhone: '024 412 3456',
          instructions: 'Ask at the front desk',
          ghanaPostGps: 'ga1234567',
          openingHours: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']
            .map((weekday) => ({ weekday, opens: '08:00', closes: '17:00' }))
            .concat({ weekday: 'SATURDAY', opens: '09:00', closes: '13:00' }),
        },
      },
    );
    expect(res.body.errors).toBeUndefined();
    pointId = res.body.data.createPickupLocation.id;

    const listed = await gqlRequest(app, `{ activePickupLocations { ${POINT} } }`).expect(200);

    expect(listed.body.data.activePickupLocations).toEqual([
      expect.objectContaining({
        region: 'GREATER_ACCRA',
        contactPhone: '+233244123456',
        ghanaPostGps: 'GA-123-4567',
        openingHoursText: 'Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed',
      }),
    ]);
    expect(
      await prisma.auditLog.count({ where: { entity: 'PickupLocation', entityId: pointId, action: 'CREATE' } }),
    ).toBe(1);
  });

  it('refuses invalid hours and customers', async () => {
    const bad = await adminGql(
      `mutation { updatePickupLocation(id: "${pointId}", input: { openingHours: [{ weekday: MONDAY, opens: "17:00", closes: "08:00" }] }) { id } }`,
    );
    const customer = await gqlRequest(
      app,
      `mutation { updatePickupLocation(id: "${pointId}", input: { name: "Mine" }) { id } }`,
      undefined,
      await signInUser(app),
    ).expect(200);

    expect(bad.body.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(customer.body.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('emails and texts the customer once when the order is ready at the counter', async () => {
    const email = worker.get(EmailService);
    const sms = worker.get(SmsSender);
    const emails = jest.spyOn(email, 'sendReadyForPickupEmail').mockResolvedValue();
    const texts = jest.spyOn(sms, 'send').mockResolvedValue();
    const orderNumber = await takeOrderNumber(prisma);
    const order = await prisma.order.create({
      data: {
        orderNumber,
        userId: 'seed_user',
        status: 'CONFIRMED',
        fulfillmentType: 'PICKUP',
        pickupLocationId: pointId,
        grandTotal: 120,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: '+233244000111',
      },
    });

    await worker
      .get(ShipmentsService)
      .updateShipmentStatus(await shipmentOf(prisma, order.id), ShipmentStatus.READY_FOR_PICKUP, 'seed_admin');

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'shipment.status_changed.v1', aggregateId: order.id },
    });
    await waitUntil(async () => texts.mock.calls.length > 0);
    const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
    await waitUntil(async () => (await (await queue.getJob(event.id))?.getState()) === 'completed');
    // The event job runs again (redelivery): the sent marker stops a second email and SMS.
    await (await queue.getJob(event.id))!.retry('completed');
    await waitUntil(async () => (await (await queue.getJob(event.id))?.getState()) === 'completed');
    await sleep(1_000);

    expect(emails).toHaveBeenCalledTimes(1);
    expect(emails).toHaveBeenCalledWith(
      'user@example.com',
      order.id,
      expect.objectContaining({
        orderNumber,
        pickupName: 'Osu Store',
        hours: 'Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed',
        contactPhone: '+233244123456',
      }),
      event.id,
    );
    expect(texts).toHaveBeenCalledTimes(1);
    expect(texts).toHaveBeenCalledWith(
      '+233244000111',
      `Order #${orderNumber} is ready for pickup at Osu Store, 12 Oxford St, Accra. Open: Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed.`,
      'ready_for_pickup',
    );
  });
});
