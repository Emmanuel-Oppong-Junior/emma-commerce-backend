import { INestApplication, INestApplicationContext } from '@nestjs/common';
import * as request from 'supertest';
import { setTimeout as sleep } from 'node:timers/promises';
import { OrderStatus, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { CloudinaryService } from '../../src/commons/cloudinary.service';
import { SmsSender } from '../../src/notifications/sms/sms-sender';
import { EmailService } from '../../src/notifications/email/email.service';
import { NotificationSender } from '../../src/notifications/notification-sender';
import { AppMetrics } from '../../src/observability/metrics';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string; attemptsLeft?: number } }[];
}

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const ADDRESS_PHONE = '+233201112222';
const CODE_IN_TEXT = /code when you receive it: (\d{6})\./;

async function waitUntil(condition: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

// Proof of delivery (P5-C.2): the delivery code texted at dispatch, confirming with it or a staff override, photos,
// cash on delivery in the same call, and what customers and staff see.
describe('Proof of delivery (P5-C.2, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let sms: jest.SpyInstance;
  let adminToken: string;
  let userToken: string;
  let rider: { id: string; token: string };
  let otherRider: { id: string; token: string };
  let cashierToken: string;
  let phoneSeq = 0;

  const cloudinary = {
    uploadImage: jest.fn(async (_file: unknown, folder: string) => ({
      public_id: `${folder}/photo1`,
      secure_url: `https://res.cloudinary.test/${folder}/photo1.png`,
    })),
    urlFor: jest.fn((publicId: string) => `https://res.cloudinary.test/${publicId}`),
  };

  const gql = async (query: string, token = adminToken): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;
  const reasonOf = (result: GqlResult) => result.errors?.[0]?.extensions.reason;

  const staffMember = async (email: string, roleKey: string) => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: email.split('@')[0] });
    const [user, store, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email } }),
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return { id: user.id, token: accessToken };
  };

  /** A confirmed delivery order of two units with one PENDING shipment per entry of `split`. */
  const orderWithShipments = async (paymentMethod: PaymentMethod = PaymentMethod.ONLINE, split = [2]) => {
    phoneSeq += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        status: OrderStatus.CONFIRMED,
        paymentMethod,
        fulfillmentType: 'DELIVERY',
        grandTotal: 40,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+2332447${String(phoneSeq).padStart(5, '0')}`,
        shippingAddressSnapshot: {
          recipientName: 'Ama Mensah',
          phone: ADDRESS_PHONE,
          street: '12 Oxford St',
          city: 'Accra',
        },
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
    const shipmentIds: string[] = [];
    for (const quantity of split) {
      const created = await gql(
        `mutation { createShipment(input: { orderId: "${order.id}", items: [{ orderItemId: "${order.items[0].id}", quantity: ${quantity} }] }) { id } }`,
      );
      expect(created.errors).toBeUndefined();
      shipmentIds.push(created.data!.createShipment.id);
    }
    return { orderId: order.id, orderNumber: order.orderNumber, shipmentIds };
  };

  /** Assigns the rider, packs and takes the shipment out as the rider; returns the code texted to the customer. */
  const dispatch = async (shipmentId: string, who = rider): Promise<string> => {
    const sendsBefore = sms.mock.calls.length;
    expect(
      (
        await gql(
          `mutation { assignShipmentRider(input: { shipmentId: "${shipmentId}", riderId: "${who.id}" }) { id } }`,
        )
      ).errors,
    ).toBeUndefined();
    await gql(`mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: PACKED }) { id } }`);
    const out = await gql(`mutation { startMyDelivery(shipmentId: "${shipmentId}") { status } }`, who.token);
    expect(out.errors).toBeUndefined();
    const { order } = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { order: true } });
    // Another shipment's milestone SMS can land late under load, so pick this order's code text, not the last send.
    const codeSms = () =>
      (sms.mock.calls.slice(sendsBefore) as [string, string][]).find(
        ([, text]) => CODE_IN_TEXT.test(text) && text.includes(`#${order.orderNumber} `),
      );
    await waitUntil(() => codeSms() !== undefined);
    const [to, text] = codeSms()!;
    expect(to).toBe(ADDRESS_PHONE);
    const code = CODE_IN_TEXT.exec(text)?.[1];
    expect(code).toBeDefined();
    return code!;
  };

  const completeMine = (shipmentId: string, fields: string, token = rider.token) =>
    gql(
      `mutation { completeMyDelivery(input: { shipmentId: "${shipmentId}", ${fields} }) { shipmentId status deliveredAt amountToCollect { amount } } }`,
      token,
    );
  const complete = (shipmentId: string, fields: string, token = adminToken) =>
    gql(
      `mutation { completeDelivery(input: { shipmentId: "${shipmentId}", ${fields} }) { id status proofOfDelivery { method overrideReason deliveredById photoUrl recipientName latitude longitude } } }`,
      token,
    );
  const wrongCodeFor = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) =>
      builder.overrideProvider(CloudinaryService).useValue(cloudinary),
    ));
    worker = await createTestWorker();
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    userToken = await signInUser(app);
    rider = await staffMember('pod-rider@test.local', 'RIDER');
    otherRider = await staffMember('pod-rider-2@test.local', 'RIDER');
    cashierToken = (await staffMember('pod-cashier@test.local', 'CASHIER')).token;
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    sms = jest.spyOn(worker.get(SmsSender), 'send').mockResolvedValue();
    jest.spyOn(worker.get(EmailService), 'sendOrderStatusEmail').mockResolvedValue();
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  it('texts the customer one out-for-delivery SMS with the code; a retried job resends the same code', async () => {
    const { orderNumber, shipmentIds } = await orderWithShipments();
    const code = await dispatch(shipmentIds[0]);

    expect(sms).toHaveBeenCalledTimes(1);
    expect(sms.mock.calls[0][1]).toBe(
      `Your order #${orderNumber} is out for delivery. Give the rider this code when you receive it: ${code}.`,
    );
    await sleep(1_000);
    expect(sms).toHaveBeenCalledTimes(1);

    const shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: shipmentIds[0] } });
    await worker
      .get(NotificationSender)
      .send(
        'sms.shipment_milestone.v1',
        { orderId: shipment.orderId, shipmentId: shipment.id, status: 'OUT_FOR_DELIVERY' },
        'retry',
      );
    expect(CODE_IN_TEXT.exec(sms.mock.calls[1][1] as string)?.[1]).toBe(code);
  });

  it('locks the code after five wrong entries, then only a staff override with delivery.override delivers', async () => {
    const failures = jest.spyOn(app.get(AppMetrics), 'recordDeliveryCodeFailure');
    const overrides = jest.spyOn(app.get(AppMetrics), 'recordDeliveryOverride');
    const { orderId, shipmentIds } = await orderWithShipments();
    const [shipmentId] = shipmentIds;
    const code = await dispatch(shipmentId);

    const staffStep = await gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: DELIVERED }) { id } }`,
    );
    expect(reasonOf(staffStep)).toBe('PROOF_OF_DELIVERY_REQUIRED');
    expect(reasonOf(await completeMine(shipmentId, 'code: ""'))).toBeUndefined();

    const left: (number | undefined)[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const wrong = await completeMine(shipmentId, `code: "${wrongCodeFor(code)}"`);
      expect(reasonOf(wrong)).toBe('DELIVERY_CODE_INVALID');
      left.push(wrong.errors![0].extensions.attemptsLeft);
    }
    expect(left).toEqual([4, 3, 2, 1]);
    expect(reasonOf(await completeMine(shipmentId, `code: "${wrongCodeFor(code)}"`))).toBe('DELIVERY_CODE_LOCKED');
    expect(reasonOf(await completeMine(shipmentId, `code: "${code}"`))).toBe('DELIVERY_CODE_LOCKED');
    expect(failures.mock.calls.map(([kind]) => kind)).toEqual([
      'WRONG_CODE',
      'WRONG_CODE',
      'WRONG_CODE',
      'WRONG_CODE',
      'LOCKED',
      'LOCKED',
    ]);
    expect(await prisma.proofOfDelivery.count({ where: { shipmentId } })).toBe(0);

    const noPermission = await complete(shipmentId, 'overrideReason: "Customer lost the SMS"', cashierToken);
    expect([codeOf(noPermission), reasonOf(noPermission)]).toEqual(['FORBIDDEN', 'OVERRIDE_NOT_ALLOWED']);
    // A rider's input has no override at all.
    const riderOverride = await gqlRequest(
      app,
      `mutation { completeMyDelivery(input: { shipmentId: "${shipmentId}", code: "${code}", overrideReason: "x" }) { status } }`,
      undefined,
      rider.token,
    );
    expect(riderOverride.status).toBe(400);

    const overridden = await complete(shipmentId, 'overrideReason: "Customer lost the SMS"');
    expect(overridden.errors).toBeUndefined();
    expect(overridden.data!.completeDelivery).toMatchObject({
      status: 'DELIVERED',
      proofOfDelivery: { method: 'OVERRIDE', overrideReason: 'Customer lost the SMS', deliveredById: 'seed_admin' },
    });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
    expect(overrides).toHaveBeenCalledTimes(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Shipment', entityId: shipmentId, action: 'PROOF_OF_DELIVERY' },
    });
    expect(audit).toMatchObject({ userId: 'seed_admin' });
    expect(audit.details).toMatchObject({
      method: 'OVERRIDE',
      riderId: rider.id,
      overrideReason: 'Customer lost the SMS',
    });
    await expect(
      prisma.proofOfDelivery.updateMany({ where: { shipmentId }, data: { overrideReason: 'changed' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('delivers with the right code and an optional photo; the order completes with its last shipment', async () => {
    const { orderId, shipmentIds } = await orderWithShipments(PaymentMethod.ONLINE, [1, 1]);
    const [first, second] = shipmentIds;
    const firstCode = await dispatch(first);

    const stranger = await request(app.getHttpServer())
      .post(`/delivery/my-shipments/${first}/photo`)
      .set('Authorization', `Bearer ${otherRider.token}`)
      .attach('file', ONE_PIXEL_PNG, 'door.png');
    expect(stranger.status).toBe(404);
    const upload = await request(app.getHttpServer())
      .post(`/delivery/my-shipments/${first}/photo`)
      .set('Authorization', `Bearer ${rider.token}`)
      .attach('file', ONE_PIXEL_PNG, 'door.png')
      .expect(201);
    expect(upload.body).toEqual({
      publicId: `proof-of-delivery/${first}/photo1`,
      url: `https://res.cloudinary.test/proof-of-delivery/${first}/photo1.png`,
    });
    const notImage = await request(app.getHttpServer())
      .post(`/delivery/my-shipments/${first}/photo`)
      .set('Authorization', `Bearer ${rider.token}`)
      .attach('file', Buffer.from('not an image'), 'door.png');
    expect(notImage.status).toBe(400);

    const foreignPhoto = await completeMine(
      first,
      `code: "${firstCode}", photoPublicId: "proof-of-delivery/${second}/photo1"`,
    );
    expect(reasonOf(foreignPhoto)).toBe('INVALID_DELIVERY_PHOTO');
    expect(codeOf(await completeMine(first, `code: "${firstCode}"`, otherRider.token))).toBe('NOT_FOUND');

    const delivered = await completeMine(
      first,
      `code: "${firstCode}", photoPublicId: "${upload.body.publicId}", recipientName: "Kofi (brother)", latitude: 5.556, longitude: -0.1969`,
    );
    expect(delivered.errors).toBeUndefined();
    expect(delivered.data!.completeMyDelivery).toMatchObject({ status: 'DELIVERED', amountToCollect: null });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('IN_FULFILMENT');
    const proof = await prisma.proofOfDelivery.findUniqueOrThrow({ where: { shipmentId: first } });
    expect(proof).toMatchObject({
      method: 'CODE',
      deliveredById: rider.id,
      photoPublicId: `proof-of-delivery/${first}/photo1`,
      photoUrl: `https://res.cloudinary.test/proof-of-delivery/${first}/photo1`,
      recipientName: 'Kofi (brother)',
    });
    expect(proof.latitude?.toFixed(6)).toBe('5.556000');
    expect(
      await prisma.shipmentStatusEvent.count({ where: { shipmentId: first, to: 'DELIVERED', actorId: rider.id } }),
    ).toBe(1);

    const secondCode = await dispatch(second);
    expect(secondCode).toMatch(/^\d{6}$/);
    expect((await completeMine(second, `code: "${secondCode}"`)).errors).toBeUndefined();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');

    const timeline = await gql(
      `{ order(orderId: "${orderId}") { trackingTimeline { shipmentId shipmentStatus deliveryConfirmation { method confirmedAt } } } }`,
      userToken,
    );
    expect(timeline.errors).toBeUndefined();
    const confirmed = timeline.data!.order.trackingTimeline.filter(
      (step: { deliveryConfirmation: unknown }) => step.deliveryConfirmation,
    );
    expect(confirmed.map((step: { shipmentId: string }) => step.shipmentId).sort()).toEqual([first, second].sort());
    expect(confirmed[0].deliveryConfirmation.method).toBe('CODE');
    const customerProof = await gql(
      `{ order(orderId: "${orderId}") { shipments { proofOfDelivery { photoUrl } } } }`,
      userToken,
    );
    expect(codeOf(customerProof)).toBe('FORBIDDEN');
    const staffProof = await gql(
      `{ viewOrder(id: "${orderId}") { shipments { proofOfDelivery { method photoUrl recipientName } } } }`,
    );
    expect(
      staffProof.data!.viewOrder.shipments.map(
        (s: { proofOfDelivery: { method: string } }) => s.proofOfDelivery.method,
      ),
    ).toEqual(['CODE', 'CODE']);
  });

  it('records cash on delivery with the delivery, as the rider’s, in one call', async () => {
    const { orderId, shipmentIds } = await orderWithShipments(PaymentMethod.CASH_ON_DELIVERY);
    const [shipmentId] = shipmentIds;
    const code = await dispatch(shipmentId);

    const viaStaffCash = await gql(
      `mutation { recordCodPayment(input: { orderId: "${orderId}", riderId: "${rider.id}", amount: "40.00" }) { id } }`,
    );
    expect(reasonOf(viaStaffCash)).toBe('PROOF_OF_DELIVERY_REQUIRED');
    expect(reasonOf(await completeMine(shipmentId, `code: "${code}"`))).toBe('CASH_COLLECTION_REQUIRED');
    expect(reasonOf(await completeMine(shipmentId, `code: "${code}", cashCollected: "39.00"`))).toBe(
      'COLLECTION_AMOUNT_MISMATCH',
    );
    expect(await prisma.proofOfDelivery.count({ where: { shipmentId } })).toBe(0);

    const delivered = await completeMine(shipmentId, `code: "${code}", cashCollected: "40.00"`);
    expect(delivered.errors).toBeUndefined();
    expect(delivered.data!.completeMyDelivery.status).toBe('DELIVERED');
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { paymentIntent: true } });
    expect(order.status).toBe('COMPLETED');
    expect(order.paymentIntent?.status).toBe('CAPTURED');
    const collection = await prisma.cashCollection.findFirstOrThrow({ where: { orderId } });
    expect(collection).toMatchObject({ riderId: rider.id, recordedById: rider.id, remittanceId: null });
    expect(collection.amount.toFixed(2)).toBe('40.00');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Shipment', entityId: shipmentId, action: 'PROOF_OF_DELIVERY' },
    });
    expect(audit.details).toMatchObject({ method: 'CODE', cashCollectionId: collection.id });

    const unremitted = await gql(`{ unremittedCashCollections(riderId: "${rider.id}") { id } }`);
    expect(unremitted.data!.unremittedCashCollections.map((c: { id: string }) => c.id)).toContain(collection.id);
  });

  it('confirms delivery only for a rider’s shipment out for delivery, and keeps the old path for shipments without one', async () => {
    const { orderId, shipmentIds } = await orderWithShipments();
    const [shipmentId] = shipmentIds;
    expect(reasonOf(await complete(shipmentId, 'overrideReason: "x"'))).toBe('RIDER_NOT_ASSIGNED');
    await gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: OUT_FOR_DELIVERY }) { id } }`,
    );
    expect(reasonOf(await complete(shipmentId, 'overrideReason: "x"'))).toBe('RIDER_NOT_ASSIGNED');
    const plain = await gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: DELIVERED }) { status } }`,
    );
    expect(plain.errors).toBeUndefined();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
    expect(await prisma.proofOfDelivery.count({ where: { shipmentId } })).toBe(0);
  });
});
