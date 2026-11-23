import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { SerialUnitsRepository } from '../../src/inventory/serials/serial-units.repository';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock, stockOf, verifyPhoneForCod } from '../helpers/db.helper';
import { quoteHashFor } from '../helpers/checkout.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
}

const SHIPMENT_FIELDS = 'id orderId status items { id orderItemId quantity } cancelledAt events { from to }';

describe('Split shipments (P5-B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userToken: string;
  let adminToken: string;
  let addressId: string;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(async (reference: string) => {
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { reference } });
      return { reference, status: 'success', amount: attempt.amount.mul(100).toNumber(), currency: 'GHS' };
    }),
    createRefund: jest.fn(async () => ({ id: `rf_${Date.now()}`, status: 'pending' })),
  };

  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>): Promise<GqlResult> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;
  const reasonOf = (result: GqlResult) => result.errors?.[0]?.extensions.reason;

  const placeOrder = async (options: { cod?: boolean; quantity?: number } = {}) => {
    await gql(
      `mutation { addToCart(input: { variantId: "seed_var2", quantity: ${options.quantity ?? 3} }) { id } }`,
      userToken,
    );
    const quoteHash = await quoteHashFor(app, userToken, { fulfillmentType: 'DELIVERY', shippingAddressId: addressId });
    const res = await gql(
      `mutation { createOrder(input: { fulfillmentType: DELIVERY, shippingAddressId: "${addressId}", quoteHash: "${quoteHash}",
        contactEmail: "user@example.com", contactPhone: "+233244000000",
        paymentMethod: ${options.cod ? 'CASH_ON_DELIVERY' : 'ONLINE'} }) { id items { id quantity } } }`,
      userToken,
    );
    expect(res.errors).toBeUndefined();
    const order = res.data!.createOrder as { id: string; items: { id: string; quantity: number }[] };
    return { orderId: order.id, orderItemId: order.items[0].id };
  };

  const payOnline = async (orderId: string) => {
    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId, paymentMethod: 'CARD' })
      .expect(201);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { intent: { orderId } },
      orderBy: { createdAt: 'desc' },
    });
    const res = await gql(
      `mutation { verifyPayment(verifyPaymentInput: { reference: "${attempt.reference}" }) { status } }`,
      userToken,
    );
    expect(res.errors).toBeUndefined();
  };

  const createShipment = (orderId: string, items?: { orderItemId: string; quantity: number }[], token = adminToken) =>
    gql(`mutation($input: CreateShipmentInput!) { createShipment(input: $input) { ${SHIPMENT_FIELDS} } }`, token, {
      input: { orderId, ...(items && { items }) },
    });
  const move = (shipmentId: string, status: string, token = adminToken) =>
    gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: ${status} }) { id status } }`,
      token,
    );
  const cancelShipment = (shipmentId: string, token = adminToken) =>
    gql(`mutation { cancelShipment(input: { shipmentId: "${shipmentId}", reason: "Repack" }) { id status } }`, token);
  const orderStatus = async (orderId: string) =>
    (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status;
  const reconcile = () =>
    new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
      app.get(SerialUnitsRepository),
    ).reconcile();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await verifyPhoneForCod(prisma);
    await setStock(prisma, 'seed_var2', 200);
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Split St',
        city: 'Accra',
        country: 'GH',
      },
    });
    addressId = address.id;
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('keeps the single-shipment flow: one shipment with everything, delivered, completes the order', async () => {
    const { orderId, orderItemId } = await placeOrder();
    await payOnline(orderId);

    const created = await createShipment(orderId);
    expect(created.errors).toBeUndefined();
    const shipment = created.data!.createShipment;
    expect(shipment).toMatchObject({ status: 'PENDING', items: [{ orderItemId, quantity: 3 }] });

    for (const step of ['PICKING', 'PACKED', 'OUT_FOR_DELIVERY']) {
      expect((await move(shipment.id, step)).errors).toBeUndefined();
    }
    expect(await orderStatus(orderId)).toBe('IN_FULFILMENT');
    expect((await move(shipment.id, 'DELIVERED')).errors).toBeUndefined();
    expect(await orderStatus(orderId)).toBe('COMPLETED');
    expect(await reconcile()).toEqual([]);
  });

  it('splits an online order in two, dispatches and delivers them apart, and completes only after the second', async () => {
    const { orderId, orderItemId } = await placeOrder();
    await payOnline(orderId);

    const first = (await createShipment(orderId, [{ orderItemId, quantity: 2 }])).data!.createShipment;
    const second = (await createShipment(orderId)).data!.createShipment;
    expect(second.items).toEqual([expect.objectContaining({ orderItemId, quantity: 1 })]);

    await move(first.id, 'OUT_FOR_DELIVERY');
    expect(await reconcile()).toEqual([]);
    await move(first.id, 'DELIVERED');
    expect(await orderStatus(orderId)).toBe('IN_FULFILMENT');

    await move(second.id, 'OUT_FOR_DELIVERY');
    await move(second.id, 'DELIVERED');
    expect(await orderStatus(orderId)).toBe('COMPLETED');
    expect(await prisma.outboxEvent.count({ where: { aggregateId: orderId, type: 'order.status_changed.v2' } })).toBe(
      1,
    );

    const listed = await gql(`{ orderShipments(orderId: "${orderId}") { id status items { quantity } } }`);
    expect(listed.data!.orderShipments.map((s: { status: string }) => s.status)).toEqual(['DELIVERED', 'DELIVERED']);
    expect(await reconcile()).toEqual([]);
  });

  it('refuses over-allocation, also when two creates race, and gives a cancelled shipment’s units back', async () => {
    const { orderId, orderItemId } = await placeOrder();
    await payOnline(orderId);

    const tooMany = await createShipment(orderId, [{ orderItemId, quantity: 4 }]);
    expect(codeOf(tooMany)).toBe('CONFLICT');
    expect(reasonOf(tooMany)).toBe('SHIPMENT_QUANTITY_EXCEEDED');

    const raced = await Promise.all([
      createShipment(orderId, [{ orderItemId, quantity: 2 }]),
      createShipment(orderId, [{ orderItemId, quantity: 2 }]),
    ]);
    expect(raced.filter((res) => !res.errors)).toHaveLength(1);
    expect(reasonOf(raced.find((res) => res.errors)!)).toBe('SHIPMENT_QUANTITY_EXCEEDED');
    const winner = raced.find((res) => !res.errors)!.data!.createShipment;

    expect((await cancelShipment(winner.id)).errors).toBeUndefined();
    const cancelled = await prisma.shipment.findUniqueOrThrow({ where: { id: winner.id } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledAt: expect.any(Date) });
    const again = await createShipment(orderId);
    expect(again.data!.createShipment.items).toEqual([expect.objectContaining({ quantity: 3 })]);
    expect(reasonOf(await createShipment(orderId))).toBe('NOTHING_TO_SHIP');

    await move(again.data!.createShipment.id, 'OUT_FOR_DELIVERY');
    expect(codeOf(await cancelShipment(again.data!.createShipment.id))).toBe('CONFLICT');
  });

  it('backs the allocation rule with the database trigger', async () => {
    const { orderId, orderItemId } = await placeOrder();
    await payOnline(orderId);
    const shipment = await prisma.shipment.create({ data: { orderId } });

    await expect(
      prisma.shipmentItem.create({ data: { shipmentId: shipment.id, orderItemId, quantity: 4 } }),
    ).rejects.toThrow(/would be in shipments/);
    const other = await placeOrder();
    await expect(
      prisma.shipmentItem.create({ data: { shipmentId: shipment.id, orderItemId: other.orderItemId, quantity: 1 } }),
    ).rejects.toThrow(/not on the order/);
  });

  it('does not split a cash-on-delivery order, and its dispatch consumes its stock once', async () => {
    const before = await stockOf(prisma, 'seed_var2');
    const { orderId, orderItemId } = await placeOrder({ cod: true });

    const split = await createShipment(orderId, [{ orderItemId, quantity: 1 }]);
    expect(codeOf(split)).toBe('BAD_REQUEST');
    expect(reasonOf(split)).toBe('COD_ORDER_NOT_SPLIT');

    const whole = (await createShipment(orderId)).data!.createShipment;
    await move(whole.id, 'PACKED');
    expect(await prisma.stockReservation.findMany({ where: { orderId }, select: { status: true } })).toEqual([
      { status: 'ACTIVE' },
    ]);
    expect((await move(whole.id, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();
    expect(await prisma.stockReservation.findMany({ where: { orderId }, select: { status: true } })).toEqual([
      { status: 'CONSUMED' },
    ]);
    expect((await stockOf(prisma, 'seed_var2')).onHand).toBe(before.onHand - 3);
    expect(await prisma.stockMovement.count({ where: { refType: 'Order', refId: orderId, reason: 'SALE' } })).toBe(1);
  });

  it('cancels the open shipments with the order before dispatch, and refuses the order cancel after a partial dispatch', async () => {
    const early = await placeOrder();
    await payOnline(early.orderId);
    const pending = (await createShipment(early.orderId, [{ orderItemId: early.orderItemId, quantity: 1 }])).data!
      .createShipment;
    await move(pending.id, 'PICKING');
    const cancelled = await gql(`mutation { adminCancelOrder(orderId: "${early.orderId}") { status } }`);
    expect(cancelled.data!.adminCancelOrder.status).toBe('CANCELLED');
    expect((await prisma.shipment.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('CANCELLED');

    const late = await placeOrder();
    await payOnline(late.orderId);
    const out = (await createShipment(late.orderId, [{ orderItemId: late.orderItemId, quantity: 1 }])).data!
      .createShipment;
    const rest = (await createShipment(late.orderId)).data!.createShipment;
    await move(out.id, 'OUT_FOR_DELIVERY');
    expect(codeOf(await gql(`mutation { adminCancelOrder(orderId: "${late.orderId}") { status } }`))).toBe('CONFLICT');

    // The rest will not ship: staff refund it, cancel its shipment, and the order completes once the first arrives.
    const refund = await prisma.refund.create({
      data: {
        attemptId: (await prisma.paymentAttempt.findFirstOrThrow({ where: { intent: { orderId: late.orderId } } })).id,
        amount: 1,
        idempotencyKey: `split-test:${late.orderId}`,
        reason: 'OTHER',
        note: 'Not shipping the rest',
        status: 'PROCESSED',
        lines: { create: { orderItemId: late.orderItemId, quantity: 2, amount: 1 } },
      },
    });
    expect(refund.id).toBeDefined();
    expect((await cancelShipment(rest.id)).errors).toBeUndefined();
    expect(await orderStatus(late.orderId)).toBe('IN_FULFILMENT');
    await move(out.id, 'DELIVERED');
    expect(await orderStatus(late.orderId)).toBe('COMPLETED');
  });

  it('requires order.fulfil to create or cancel shipments, order.view to list them, and audits each change', async () => {
    const { accessToken: support } = await signUpUser(app, {
      email: 'split-support@test.local',
      password: 'Str0ng!Passw0rd',
      name: 'Support',
    });
    const supportUser = await prisma.user.findUniqueOrThrow({ where: { email: 'split-support@test.local' } });
    const [store, role] = await Promise.all([
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: 'SUPPORT' } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: supportUser.id, storeId: store.id, roleId: role.id } });
    const { orderId } = await placeOrder();
    await payOnline(orderId);

    expect(codeOf(await createShipment(orderId, undefined, support))).toBe('FORBIDDEN');
    expect(codeOf(await createShipment(orderId, undefined, userToken))).toBe('FORBIDDEN');
    const created = (await createShipment(orderId)).data!.createShipment;
    expect(codeOf(await cancelShipment(created.id, support))).toBe('FORBIDDEN');
    expect((await gql(`{ orderShipments(orderId: "${orderId}") { id } }`, support)).errors).toBeUndefined();
    expect(codeOf(await gql(`{ orderShipments(orderId: "${orderId}") { id } }`, userToken))).toBe('FORBIDDEN');
    await cancelShipment(created.id);

    const audits = await prisma.auditLog.findMany({
      where: { entity: 'Shipment', entityId: created.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['CREATE', 'STATUS_CHANGE']);
  });
});
