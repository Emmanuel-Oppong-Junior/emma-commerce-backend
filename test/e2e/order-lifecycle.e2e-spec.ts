import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock, stockOf, verifyPhoneForCod } from '../helpers/db.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';
import { quoteHashFor } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string } }[];
}

const ORDER_FIELDS = `id status paymentStatus
  timeline { from to reason }
  shipments { status trackingNumber dispatchedAt deliveredAt events { from to } }`;

describe('Order, payment and fulfilment state machines (P1-O.2, e2e)', () => {
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
    // Paystack reports success for exactly what the attempt asked for.
    verifyTransaction: jest.fn(async (reference: string) => {
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { reference } });
      return { reference, status: 'success', amount: attempt.amount.mul(100).toNumber(), currency: 'GHS' };
    }),
    createRefund: jest.fn(async () => ({ id: `rf_${Date.now()}`, status: 'pending' })),
  };

  const gql = async (query: string, token = adminToken): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;

  const placeOrder = async (options: { cod?: boolean; pickup?: boolean; token?: string } = {}): Promise<string> => {
    const token = options.token ?? userToken;
    await gql('mutation { addToCart(input: { variantId: "seed_var2", quantity: 2 }) { id } }', token);
    const place = options.pickup
      ? 'fulfillmentType: PICKUP, pickupLocationId: "lifecycle_pickup"'
      : `fulfillmentType: DELIVERY, shippingAddressId: "${addressId}"`;
    const quoteHash = await quoteHashFor(
      app,
      token,
      options.pickup
        ? { fulfillmentType: 'PICKUP', pickupLocationId: 'lifecycle_pickup' }
        : { fulfillmentType: 'DELIVERY', shippingAddressId: addressId },
    );
    const res = await gql(
      `mutation { createOrder(input: { ${place}, quoteHash: "${quoteHash}", contactEmail: "user@example.com", contactPhone: "+233244000000",
        paymentMethod: ${options.cod ? 'CASH_ON_DELIVERY' : 'ONLINE'} }) { id } }`,
      token,
    );
    expect(res.errors).toBeUndefined();
    return res.data!.createOrder.id;
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
    return attempt;
  };

  const moveShipment = async (orderId: string, status: string, token = adminToken) =>
    gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, orderId)}", status: ${status} }) { ${ORDER_FIELDS} } }`,
      token,
    );
  const viewOrder = async (orderId: string) =>
    (await gql(`query { viewOrder(id: "${orderId}") { ${ORDER_FIELDS} } }`)).data!.viewOrder;
  const reservationsOf = (orderId: string) =>
    prisma.stockReservation.findMany({ where: { orderId }, select: { status: true, quantity: true } });
  const salesOf = (orderId: string) =>
    prisma.stockMovement.count({ where: { refType: 'Order', refId: orderId, reason: 'SALE' } });

  /** A customer account with the given system staff role, signed in. */
  const staffWithRole = async (roleKey: string, email: string): Promise<string> => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: roleKey });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const [store, role] = await Promise.all([
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return accessToken;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await verifyPhoneForCod(prisma);
    await setStock(prisma, 'seed_var2', 100);
    await prisma.pickupLocation.create({
      data: {
        id: 'lifecycle_pickup',
        name: 'Osu Store',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Lifecycle St',
        city: 'Accra',
        country: 'GH',
      },
    });
    addressId = address.id;
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('takes an online order PLACED -> CONFIRMED -> IN_FULFILMENT -> COMPLETED, with its timeline and shipment history', async () => {
    const orderId = await placeOrder();
    expect((await viewOrder(orderId)).status).toBe('PLACED');

    await payOnline(orderId);
    const confirmed = await viewOrder(orderId);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', paymentStatus: 'CAPTURED', shipments: [] });

    for (const step of ['PICKING', 'PACKED', 'OUT_FOR_DELIVERY']) {
      const res = await moveShipment(orderId, step);
      expect(res.errors).toBeUndefined();
      expect(res.data!.updateShipmentStatus.status).toBe('IN_FULFILMENT');
    }
    const delivered = await moveShipment(orderId, 'DELIVERED');

    expect(delivered.errors).toBeUndefined();
    const order = delivered.data!.updateShipmentStatus;
    expect(order.status).toBe('COMPLETED');
    expect(order.timeline.map((e: { from: string | null; to: string }) => [e.from, e.to])).toEqual([
      [null, 'PLACED'],
      ['PLACED', 'CONFIRMED'],
      ['CONFIRMED', 'IN_FULFILMENT'],
      ['IN_FULFILMENT', 'COMPLETED'],
    ]);
    expect(order.timeline[1].reason).toBe('Payment captured');
    expect(order.shipments).toHaveLength(1);
    expect(order.shipments[0]).toMatchObject({
      status: 'DELIVERED',
      dispatchedAt: expect.any(String),
      deliveredAt: expect.any(String),
    });
    expect(order.shipments[0].events.map((e: { to: string }) => e.to)).toEqual([
      'PENDING',
      'PICKING',
      'PACKED',
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
    expect(await prisma.outboxEvent.count({ where: { aggregateId: orderId, type: 'order.status_changed.v2' } })).toBe(
      1,
    );
    // Dispatch and, since P5-B.2's SMS milestones, delivery.
    const shipmentEvents = await prisma.outboxEvent.findMany({
      where: { aggregateId: orderId, type: 'shipment.status_changed.v1' },
      orderBy: { createdAt: 'asc' },
    });
    expect(shipmentEvents.map((event) => (event.payload as { status: string }).status)).toEqual([
      'OUT_FOR_DELIVERY',
      'DELIVERED',
    ]);
  });

  it('confirms a cash-on-delivery pickup order at once and consumes its stock exactly once, at the pickup counter', async () => {
    const before = await stockOf(prisma, 'seed_var2');
    const orderId = await placeOrder({ cod: true, pickup: true });
    expect((await viewOrder(orderId)).status).toBe('CONFIRMED');

    await moveShipment(orderId, 'PACKED');
    expect(await reservationsOf(orderId)).toEqual([{ status: 'ACTIVE', quantity: 2 }]);
    const ready = await moveShipment(orderId, 'READY_FOR_PICKUP');
    await moveShipment(orderId, 'FAILED_DELIVERY');
    await moveShipment(orderId, 'READY_FOR_PICKUP');

    expect(ready.errors).toBeUndefined();
    expect(await reservationsOf(orderId)).toEqual([{ status: 'CONSUMED', quantity: 2 }]);
    expect(await salesOf(orderId)).toBe(1);
    expect((await stockOf(prisma, 'seed_var2')).onHand).toBe(before.onHand - 2);

    const handOver = await moveShipment(orderId, 'DELIVERED');
    expect(codeOf(handOver)).toBe('BAD_REQUEST');
    const { grandTotal } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const cash = await gql(
      `mutation { recordCodPayment(input: { orderId: "${orderId}", riderId: "seed_admin", amount: "${grandTotal.toFixed(2)}" }) { status } }`,
    );
    expect(cash.errors).toBeUndefined();
    const completed = await viewOrder(orderId);
    expect(completed).toMatchObject({ status: 'COMPLETED', paymentStatus: 'CAPTURED' });
    expect(completed.shipments[0].status).toBe('DELIVERED');
    expect(await salesOf(orderId)).toBe(1);
  });

  it('refuses illegal steps: delivered before dispatch, the pickup counter for a delivery, an unknown status', async () => {
    const orderId = await placeOrder({ cod: true });

    expect(codeOf(await moveShipment(orderId, 'RETURNED'))).toBe('CONFLICT');
    expect(codeOf(await moveShipment(orderId, 'READY_FOR_PICKUP'))).toBe('CONFLICT');
    const unknown = await gqlRequest(
      app,
      `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, orderId)}", status: SHIPPED }) { id } }`,
      undefined,
      adminToken,
    );
    expect(unknown.status).toBe(400);
    expect((await viewOrder(orderId)).status).toBe('CONFIRMED');
  });

  it('claims a concurrent fulfilment step once', async () => {
    const orderId = await placeOrder({ cod: true });
    await shipmentOf(prisma, orderId);

    const results = await Promise.all([moveShipment(orderId, 'PICKING'), moveShipment(orderId, 'PICKING')]);

    expect(results.map((res) => (res.errors ? codeOf(res) : 'OK')).sort()).toEqual(['CONFLICT', 'OK']);
    expect(await prisma.shipment.count({ where: { orderId } })).toBe(1);
    expect(await prisma.orderStatusEvent.count({ where: { orderId, to: 'IN_FULFILMENT' } })).toBe(1);
    expect(await prisma.shipmentStatusEvent.count({ where: { shipment: { orderId }, to: 'PICKING' } })).toBe(1);
  });

  it('lets staff cancel during fulfilment only while the goods are still in the shop', async () => {
    const packedOrder = await placeOrder({ cod: true });
    await moveShipment(packedOrder, 'PACKED');
    const outOrder = await placeOrder({ cod: true });
    await moveShipment(outOrder, 'OUT_FOR_DELIVERY');

    const packedCancel = await gql(`mutation { adminCancelOrder(orderId: "${packedOrder}") { status } }`);
    const outCancel = await gql(`mutation { adminCancelOrder(orderId: "${outOrder}") { status } }`);

    expect(packedCancel.data?.adminCancelOrder.status).toBe('CANCELLED');
    expect(await reservationsOf(packedOrder)).toEqual([{ status: 'RELEASED', quantity: 2 }]);
    expect(codeOf(outCancel)).toBe('CONFLICT');
    expect((await viewOrder(outOrder)).status).toBe('IN_FULFILMENT');
  });

  it('moves a paid-after-cancellation order to PAYMENT_REVIEW and back to CANCELLED once the refund is processed', async () => {
    const orderId = await placeOrder();
    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId, paymentMethod: 'CARD' })
      .expect(201);
    await gql(`mutation { cancelOrder(orderId: "${orderId}") { status } }`, userToken);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { intent: { orderId } } });

    await gql(
      `mutation { verifyPayment(verifyPaymentInput: { reference: "${attempt.reference}" }) { status } }`,
      userToken,
    );
    expect(await viewOrder(orderId)).toMatchObject({ status: 'PAYMENT_REVIEW', paymentStatus: 'CANCELLED' });

    const refund = await prisma.refund.findFirstOrThrow({ where: { attemptId: attempt.id } });
    const sent = await gql(`mutation { processPendingRefund(refundId: "${refund.id}") { status } }`);

    expect(sent.errors).toBeUndefined();
    const order = await viewOrder(orderId);
    expect(order.status).toBe('CANCELLED');
    expect(order.timeline.map((e: { to: string }) => e.to)).toEqual([
      'PLACED',
      'CANCELLED',
      'PAYMENT_REVIEW',
      'CANCELLED',
    ]);
  });

  it('follows refunds of the accepted payment: PARTIALLY_REFUNDED, then REFUNDED', async () => {
    const orderId = await placeOrder();
    await payOnline(orderId);
    for (const step of ['OUT_FOR_DELIVERY', 'DELIVERED']) await moveShipment(orderId, step);
    const { grandTotal } = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    const refundPart = async (amount: string, reason: string) => {
      const returned = await prisma.returnRequest.create({
        data: { orderId, userId: 'seed_user', reason, status: 'APPROVED', refundAmount: amount },
      });
      const res = await gql(`mutation { processRefund(returnRequestId: "${returned.id}") { status } }`);
      expect(res.errors).toBeUndefined();
    };

    await refundPart('100.00', 'One damaged');
    expect((await viewOrder(orderId)).paymentStatus).toBe('PARTIALLY_REFUNDED');
    await refundPart(grandTotal.sub(100).toFixed(2), 'The rest');
    expect((await viewOrder(orderId)).paymentStatus).toBe('REFUNDED');
  });

  it('shows customers only their own timeline, without who acted', async () => {
    const orderId = await placeOrder();
    const otherToken = (
      await signUpUser(app, { email: 'other-buyer@test.local', password: 'Str0ng!Passw0rd', name: 'Kofi' })
    ).accessToken;

    const own = await gql(`query { order(orderId: "${orderId}") { timeline { to } } }`, userToken);
    const others = await gql(`query { order(orderId: "${orderId}") { timeline { to } } }`, otherToken);
    const actor = await gql(`query { order(orderId: "${orderId}") { timeline { actorId } } }`, userToken);

    expect(own.data!.order.timeline).toEqual([{ to: 'PLACED' }]);
    expect(codeOf(others)).toBe('NOT_FOUND');
    expect(codeOf(actor)).toBe('FORBIDDEN');
  });

  it('requires order.fulfil for fulfilment steps: a cashier may, support may not', async () => {
    const cashier = await staffWithRole('CASHIER', 'lifecycle-cashier@test.local');
    const support = await staffWithRole('SUPPORT', 'lifecycle-support@test.local');
    const orderId = await placeOrder({ cod: true });

    expect(codeOf(await moveShipment(orderId, 'PICKING', support))).toBe('FORBIDDEN');
    expect((await moveShipment(orderId, 'PICKING', cashier)).errors).toBeUndefined();
    expect(
      codeOf(
        await gql(
          `mutation { updateShipping(input: { shipmentId: "${await shipmentOf(prisma, orderId)}", trackingNumber: "T1" }) { id } }`,
          support,
        ),
      ),
    ).toBe('FORBIDDEN');
  });

  describe('migration of legacy statuses, shipping fields and payments', () => {
    const BEFORE = '20261123010000_order_totals_contract';
    const EXPAND = '20261124000000_order_state_machines';
    const CONTRACT = '20261124010000_order_state_machines_contract';
    let legacy: ScratchSchema;

    const order = (id: string, n: number, status: string, extra = "NULL, NULL, 'DELIVERY'") =>
      `('${id}', ${n}, 'u1', 'GHS', 0, 100, '${status}', ${extra}, 'legacy-sm@test.local', '+233200000000', now())`;
    const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-sm@test.local', now());
INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "updatedAt") VALUES ('v1', 'p1', 'MUG', '', 100, now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "currency", "pricingVersion", "grandTotal", "status", "trackingNumber",
                     "carrier", "fulfillmentType", "contactEmail", "contactPhone", "updatedAt") VALUES
  ${order('o_pending', 1, 'PENDING')},
  ${order('o_processing_tracked', 2, 'PROCESSING', "'TRK-2', 'DHL', 'DELIVERY'")},
  ${order('o_shipped', 3, 'SHIPPED', "'TRK-3', NULL, 'DELIVERY'")},
  ${order('o_shipped_pickup', 4, 'SHIPPED', "NULL, NULL, 'PICKUP'")},
  ${order('o_delivered', 5, 'DELIVERED', "'TRK-5', 'Rider', 'DELIVERY'")},
  ${order('o_cancelled', 6, 'CANCELLED')},
  ${order('o_expired', 7, 'CANCELLED')},
  ${order('o_paid_late', 8, 'CANCELLED')};
INSERT INTO "StockLocation" ("id", "storeId", "name", "isDefault", "updatedAt") SELECT 'loc', id, 'Main', false, now() FROM "Store";
INSERT INTO "StockMovement" ("id", "variantId", "locationId", "onHandDelta", "reservedDelta", "reason", "refType", "refId", "note") VALUES
  ('m_exp', 'v1', 'loc', 0, -1, 'RELEASE', 'Order', 'o_expired', 'Unpaid order expired'),
  ('m_can', 'v1', 'loc', 0, -1, 'RELEASE', 'Order', 'o_cancelled', 'Order cancelled');
INSERT INTO "PaymentIntent" ("id", "orderId", "amount", "status", "updatedAt") VALUES
  ('pi_pending', 'o_pending', 100, 'PENDING', now()),
  ('pi_delivered', 'o_delivered', 100, 'PAID', now()),
  ('pi_cancelled', 'o_cancelled', 100, 'PENDING', now()),
  ('pi_late', 'o_paid_late', 100, 'PENDING', now());
INSERT INTO "PaymentAttempt" ("id", "intentId", "provider", "reference", "amount", "status", "reviewReason", "channel", "updatedAt") VALUES
  ('pa_pending', 'pi_pending', 'PAYSTACK', 'r1', 100, 'ABANDONED', NULL, 'card', now()),
  ('pa_delivered', 'pi_delivered', 'PAYSTACK', 'r2', 100, 'COMPLETED', NULL, 'card', now()),
  ('pa_late', 'pi_late', 'PAYSTACK', 'r3', 100, 'COMPLETED', 'ORDER_NOT_PAYABLE', 'card', now());
INSERT INTO "Refund" ("id", "attemptId", "amount", "status", "idempotencyKey", "updatedAt") VALUES
  ('rf_part', 'pa_delivered', 40, 'PROCESSED', 'return:x', now()),
  ('rf_late', 'pa_late', 100, 'PENDING', 'auto-refund:pa_late', now());
`;

    const snapshot = async () => ({
      orders: await legacy.query<{ id: string; status: string }>(`SELECT id, status::text FROM "Order" ORDER BY id`),
      intents: await legacy.query(`SELECT id, status::text FROM "PaymentIntent" ORDER BY id`),
      attempts: await legacy.query(`SELECT id, status::text FROM "PaymentAttempt" ORDER BY id`),
      shipments: await legacy.query(
        `SELECT id, "orderId", status::text, carrier, "trackingNumber" FROM "Shipment" ORDER BY id`,
      ),
      events: await legacy.query(`SELECT id, "from"::text, "to"::text FROM "OrderStatusEvent" ORDER BY id`),
      shipmentEvents: await legacy.query(`SELECT id, "to"::text FROM "ShipmentStatusEvent" ORDER BY id`),
    });

    beforeAll(async () => {
      legacy = new ScratchSchema(prisma, 'legacy_state_machines');
      await legacy.recreate();
      await legacy.migrateTo(BEFORE);
      await legacy.exec(LEGACY_DATA);
      await legacy.exec(migrationSql(EXPAND));
    });

    afterAll(async () => {
      await legacy.drop();
    });

    it('maps every old order status, expired cancellations only where the ledger shows it, and late payments to review', async () => {
      expect((await snapshot()).orders).toEqual([
        { id: 'o_cancelled', status: 'CANCELLED' },
        { id: 'o_delivered', status: 'COMPLETED' },
        { id: 'o_expired', status: 'EXPIRED' },
        { id: 'o_paid_late', status: 'PAYMENT_REVIEW' },
        { id: 'o_pending', status: 'PLACED' },
        { id: 'o_processing_tracked', status: 'CONFIRMED' },
        { id: 'o_shipped', status: 'IN_FULFILMENT' },
        { id: 'o_shipped_pickup', status: 'IN_FULFILMENT' },
      ]);
    });

    it('maps payment states: abandoned attempts cancelled, paid intents captured or refunded, closed ones cancelled', async () => {
      const { intents, attempts } = await snapshot();

      expect(attempts).toEqual([
        { id: 'pa_delivered', status: 'CAPTURED' },
        { id: 'pa_late', status: 'CAPTURED' },
        { id: 'pa_pending', status: 'CANCELLED' },
      ]);
      expect(intents).toEqual([
        { id: 'pi_cancelled', status: 'CANCELLED' },
        { id: 'pi_delivered', status: 'PARTIALLY_REFUNDED' },
        { id: 'pi_late', status: 'CANCELLED' },
        { id: 'pi_pending', status: 'PENDING' },
      ]);
    });

    it('moves tracking and carrier to a shipment matching each order, and starts every history', async () => {
      const { shipments, events, shipmentEvents } = await snapshot();

      expect(shipments).toEqual([
        {
          id: 'legacy_shipment_o_delivered',
          orderId: 'o_delivered',
          status: 'DELIVERED',
          carrier: 'Rider',
          trackingNumber: 'TRK-5',
        },
        {
          id: 'legacy_shipment_o_processing_tracked',
          orderId: 'o_processing_tracked',
          status: 'PENDING',
          carrier: 'DHL',
          trackingNumber: 'TRK-2',
        },
        {
          id: 'legacy_shipment_o_shipped',
          orderId: 'o_shipped',
          status: 'OUT_FOR_DELIVERY',
          carrier: null,
          trackingNumber: 'TRK-3',
        },
        {
          id: 'legacy_shipment_o_shipped_pickup',
          orderId: 'o_shipped_pickup',
          status: 'READY_FOR_PICKUP',
          carrier: null,
          trackingNumber: null,
        },
      ]);
      expect(events).toHaveLength(8);
      expect(events).toContainEqual({ id: 'legacy_status_o_expired', from: null, to: 'EXPIRED' });
      expect(shipmentEvents).toHaveLength(4);
    });

    it('grants order.fulfil to the roles that fulfil orders', async () => {
      const roles = await legacy.query<{ key: string; fulfil: boolean; view: boolean }>(
        `SELECT key, 'order.fulfil' = ANY(permissions) AS fulfil, 'order.view' = ANY(permissions) AS view FROM "StaffRole" ORDER BY key`,
      );

      expect(roles).toEqual([
        { key: 'CASHIER', fulfil: true, view: true },
        { key: 'INVENTORY_CLERK', fulfil: true, view: true },
        { key: 'MANAGER', fulfil: true, view: true },
        { key: 'OWNER', fulfil: true, view: true },
        { key: 'SUPPORT', fulfil: false, view: true },
      ]);
    });

    it('changes nothing when run again, then drops the old shipping columns', async () => {
      const before = await snapshot();

      await legacy.exec(migrationSqlFrom(EXPAND, '-- Backfill'));
      expect(await snapshot()).toEqual(before);

      await legacy.exec(migrationSql(CONTRACT));
      expect(
        await legacy.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'legacy_state_machines' AND table_name = 'Order' AND column_name IN ('trackingNumber', 'carrier')`,
        ),
      ).toEqual([]);
    });
  });
});
