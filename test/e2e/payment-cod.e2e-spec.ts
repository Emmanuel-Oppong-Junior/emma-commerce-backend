import { INestApplication } from '@nestjs/common';
import { FulfillmentType, OrderStatus, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

describe('Cash-on-delivery collection (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let orderCount = 0;

  const createOrder = async (
    status: OrderStatus,
    paymentMethod: PaymentMethod = PaymentMethod.CASH_ON_DELIVERY,
    fulfillmentType: FulfillmentType = FulfillmentType.DELIVERY,
  ): Promise<string> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: '250.50',
        currency: 'GHS',
        pricingVersion: 0,
        status,
        paymentMethod,
        fulfillmentType,
        contactEmail: 'user@example.com',
        contactPhone: `+23324410${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };

  const recordCod = (orderId: string) =>
    gqlRequest(
      app,
      `mutation { recordCodPayment(orderId: "${orderId}") { id status amount { amount currency } currency paymentMethod } }`,
      undefined,
      adminToken,
    ).expect(200);

  const codeOf = (res: { body: { errors?: { extensions?: { code?: string } }[] } }) =>
    res.body.errors?.[0]?.extensions?.code;

  const ledgerOf = async (orderId: string) => ({
    status: (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
    intent: await prisma.paymentIntent.findUnique({ where: { orderId }, include: { attempts: true } }),
    collections: await prisma.cashCollection.findMany({ where: { orderId } }),
    audits: await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: orderId } }),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('records a SHIPPED delivery order as paid in cash: one collection, one completed attempt, DELIVERED, audited', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED);

    const res = await recordCod(orderId);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.recordCodPayment).toMatchObject({
      status: 'COMPLETED',
      amount: ghs('250.50'),
      currency: 'GHS',
      paymentMethod: 'CASH_ON_DELIVERY',
    });
    const ledger = await ledgerOf(orderId);
    expect(ledger.status).toBe(OrderStatus.DELIVERED);
    expect(ledger.intent?.status).toBe('PAID');
    expect(ledger.intent?.amount.toFixed(2)).toBe('250.50');
    expect(ledger.intent?.attempts).toHaveLength(1);
    expect(ledger.intent?.attempts[0]).toMatchObject({ provider: 'CASH_ON_DELIVERY', status: 'COMPLETED' });
    expect(ledger.collections).toHaveLength(1);
    expect(ledger.collections[0]).toMatchObject({
      attemptId: ledger.intent?.attempts[0].id,
      recordedById: 'seed_admin',
      currency: 'GHS',
    });
    expect(ledger.collections[0].amount.toFixed(2)).toBe('250.50');
    expect(ledger.audits).toHaveLength(1);
    expect(ledger.audits[0]).toMatchObject({
      action: 'STATUS_CHANGE',
      userId: 'seed_admin',
      details: {
        from: 'SHIPPED',
        to: 'DELIVERED',
        amount: '250.50',
        currency: 'GHS',
        cashCollectionId: ledger.collections[0].id,
        paymentId: ledger.intent?.attempts[0].id,
      },
    });
  });

  it('records a SHIPPED pickup order the same way', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED, PaymentMethod.CASH_ON_DELIVERY, FulfillmentType.PICKUP);

    const res = await recordCod(orderId);

    expect(res.body.errors).toBeUndefined();
    const ledger = await ledgerOf(orderId);
    expect(ledger.status).toBe(OrderStatus.DELIVERED);
    expect(ledger.collections).toHaveLength(1);
  });

  it.each([OrderStatus.PENDING, OrderStatus.PROCESSING, OrderStatus.CANCELLED, OrderStatus.DELIVERED])(
    'refuses a %s cash-on-delivery order and changes nothing',
    async (status) => {
      const orderId = await createOrder(status);

      const res = await recordCod(orderId);

      expect(codeOf(res)).toBe('CONFLICT');
      expect(await ledgerOf(orderId)).toEqual({ status, intent: null, collections: [], audits: [] });
    },
  );

  it('refuses a PROCESSING pickup order: it must be moved to SHIPPED first', async () => {
    const orderId = await createOrder(OrderStatus.PROCESSING, PaymentMethod.CASH_ON_DELIVERY, FulfillmentType.PICKUP);

    const res = await recordCod(orderId);

    expect(codeOf(res)).toBe('CONFLICT');
    expect(await ledgerOf(orderId)).toEqual({
      status: OrderStatus.PROCESSING,
      intent: null,
      collections: [],
      audits: [],
    });
  });

  it('refuses an online order and changes nothing', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED, PaymentMethod.ONLINE);

    const res = await recordCod(orderId);

    expect(codeOf(res)).toBe('BAD_REQUEST');
    expect(await ledgerOf(orderId)).toEqual({
      status: OrderStatus.SHIPPED,
      intent: null,
      collections: [],
      audits: [],
    });
  });

  it('refuses a soft-deleted order', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED);
    await prisma.order.update({ where: { id: orderId }, data: { deleted: true, deletedAt: new Date() } });

    const res = await recordCod(orderId);

    expect(codeOf(res)).toBe('NOT_FOUND');
    expect((await ledgerOf(orderId)).collections).toEqual([]);
  });

  it('keeps a single collection when the same order is recorded twice, one after the other', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED);

    const first = await recordCod(orderId);
    const second = await recordCod(orderId);

    expect(first.body.errors).toBeUndefined();
    expect(codeOf(second)).toBe('CONFLICT');
    const ledger = await ledgerOf(orderId);
    expect(ledger.collections).toHaveLength(1);
    expect(ledger.intent?.attempts).toHaveLength(1);
    expect(ledger.audits).toHaveLength(1);
  });

  it('keeps a single collection when the same order is recorded twice at once (double click)', async () => {
    const orderId = await createOrder(OrderStatus.SHIPPED);

    const results = await Promise.all([recordCod(orderId), recordCod(orderId)]);

    const outcomes = results.map((res) => (res.body.errors ? codeOf(res) : 'OK')).sort();
    expect(outcomes).toEqual(['CONFLICT', 'OK']);
    const ledger = await ledgerOf(orderId);
    expect(ledger.status).toBe(OrderStatus.DELIVERED);
    expect(ledger.collections).toHaveLength(1);
    expect(ledger.intent?.attempts).toHaveLength(1);
    expect(ledger.audits).toHaveLength(1);
  });
});
