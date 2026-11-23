import { INestApplication } from '@nestjs/common';
import { OrderStatus, PaymentMethod, Prisma, ShipmentStatus } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

type GqlBody = { data?: Record<string, any>; errors?: { message: string; extensions?: Record<string, unknown> }[] };

describe('Cash-on-delivery cash: collection, remittance and report (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let supportToken: string;
  let riderA: string;
  let riderB: string;
  let phone = 0;
  const collections: Record<string, string> = {};
  const startedAt = new Date(Date.now() - 60 * 60 * 1000);

  const gql = async (query: string, token = adminToken): Promise<GqlBody> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body as GqlBody;
  const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;
  const reasonOf = (body: GqlBody) => body.errors?.[0]?.extensions?.reason;

  const staffMember = async (email: string, roleKey: string): Promise<{ id: string; token: string }> => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: email.split('@')[0] });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const [store, role] = await Promise.all([
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return { id: user.id, token: accessToken };
  };

  const order = async (
    grandTotal: string,
    shipment: ShipmentStatus = ShipmentStatus.OUT_FOR_DELIVERY,
    paymentMethod: PaymentMethod = PaymentMethod.CASH_ON_DELIVERY,
  ): Promise<string> => {
    phone += 1;
    const created = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal,
        currency: 'GHS',
        pricingVersion: 0,
        status: shipment === ShipmentStatus.DELIVERED ? OrderStatus.COMPLETED : OrderStatus.IN_FULFILMENT,
        paymentMethod,
        fulfillmentType: 'DELIVERY',
        contactEmail: 'user@example.com',
        contactPhone: `+23324420${String(phone).padStart(4, '0')}`,
        shipments: {
          create: { status: shipment, ...(shipment === ShipmentStatus.DELIVERED && { deliveredAt: new Date() }) },
        },
      },
    });
    return created.id;
  };

  const recordCod = (orderId: string, riderId: string, amount: string) =>
    gql(
      `mutation { recordCodPayment(input: { orderId: "${orderId}", riderId: "${riderId}", amount: "${amount}" }) { id status } }`,
    );

  /** Collects `amount` for a new dispatched order and returns the collection id. */
  const collect = async (riderId: string, amount: string): Promise<string> => {
    const orderId = await order(amount);
    const res = await recordCod(orderId, riderId, amount);
    expect(res.errors).toBeUndefined();
    return (await prisma.cashCollection.findFirstOrThrow({ where: { orderId } })).id;
  };

  const remit = (riderId: string, amount: string, collectionIds: string[], note?: string, token = adminToken) =>
    gql(
      `mutation { recordCashRemittance(input: { riderId: "${riderId}", amount: "${amount}", collectionIds: ${JSON.stringify(collectionIds)}${note ? `, note: "${note}"` : ''} }) {
        id riderId receivedById amount { amount } expectedAmount { amount } discrepancy discrepancyKind note
        collections { id orderNumber remittanceId amount { amount } }
      } }`,
      token,
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    riderA = (await staffMember('rider-ama@test.local', 'RIDER')).id;
    riderB = (await staffMember('rider-kofi@test.local', 'RIDER')).id;
    supportToken = (await staffMember('support-cash@test.local', 'SUPPORT')).token;
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('stores who collected the cash and when, and audits the rider', async () => {
    const orderId = await order('100.00');

    const res = await recordCod(orderId, riderA, '100.00');

    expect(res.errors).toBeUndefined();
    const collection = await prisma.cashCollection.findFirstOrThrow({ where: { orderId } });
    expect(collection).toMatchObject({ riderId: riderA, recordedById: 'seed_admin', remittanceId: null });
    expect(collection.collectedAt.getTime()).toBeGreaterThan(startedAt.getTime());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Order', entityId: orderId } });
    expect(audit.details).toMatchObject({ riderId: riderA, cashCollectionId: collection.id });
    collections.a1 = collection.id;
  });

  it('refuses a rider who is not staff, or an amount other than the total, and records nothing', async () => {
    const orderId = await order('60.00');

    const customer = await recordCod(orderId, 'seed_user', '60.00');
    const unknown = await recordCod(orderId, 'no-such-user', '60.00');
    const short = await recordCod(orderId, riderA, '50.00');

    expect([codeOf(customer), reasonOf(customer)]).toEqual(['BAD_REQUEST', 'RIDER_NOT_STAFF']);
    expect(reasonOf(unknown)).toBe('RIDER_NOT_STAFF');
    expect([codeOf(short), reasonOf(short)]).toEqual(['BAD_REQUEST', 'COLLECTION_AMOUNT_MISMATCH']);
    expect(await prisma.cashCollection.count({ where: { orderId } })).toBe(0);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(OrderStatus.IN_FULFILMENT);
    await prisma.shipment.deleteMany({ where: { orderId } });
    await prisma.order.delete({ where: { id: orderId } });
  });

  it("remits a subset of a rider's collections and leaves the rest outstanding", async () => {
    collections.a2 = await collect(riderA, '200.00');
    collections.a3 = await collect(riderA, '50.25');
    collections.b1 = await collect(riderB, '80.00');
    collections.b2 = await collect(riderB, '120.00');
    collections.b3 = await collect(riderB, '30.00');

    const res = await remit(riderA, '300.00', [collections.a1, collections.a2]);

    expect(res.errors).toBeUndefined();
    const remittance = res.data!.recordCashRemittance;
    expect(remittance).toMatchObject({
      riderId: riderA,
      receivedById: 'seed_admin',
      amount: { amount: '300.00' },
      expectedAmount: { amount: '300.00' },
      discrepancy: '0.00',
      discrepancyKind: null,
      note: null,
    });
    expect(remittance.collections.map((c: { id: string }) => c.id).sort()).toEqual(
      [collections.a1, collections.a2].sort(),
    );
    const outstanding = await gql(`{ unremittedCashCollections(riderId: "${riderA}") { id amount { amount } } }`);
    expect(outstanding.data!.unremittedCashCollections).toEqual([{ id: collections.a3, amount: { amount: '50.25' } }]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'CashRemittance', entityId: remittance.id },
    });
    expect(audit).toMatchObject({ action: 'CREATE', userId: 'seed_admin' });
    expect(audit.details).toMatchObject({ riderId: riderA, amount: '300.00', discrepancy: '0.00' });
  });

  it('refuses a short remittance without a note, then records it with the note as a SHORT discrepancy', async () => {
    const withoutNote = await remit(riderB, '190.00', [collections.b1, collections.b2]);

    expect([codeOf(withoutNote), reasonOf(withoutNote)]).toEqual(['BAD_REQUEST', 'DISCREPANCY_NOTE_REQUIRED']);
    expect(await prisma.cashRemittance.count({ where: { riderId: riderB } })).toBe(0);
    expect(await prisma.cashCollection.count({ where: { riderId: riderB, remittanceId: { not: null } } })).toBe(0);

    const withNote = await remit(riderB, '190.00', [collections.b1, collections.b2], 'Customer short-paid GHS 10');

    expect(withNote.errors).toBeUndefined();
    expect(withNote.data!.recordCashRemittance).toMatchObject({
      expectedAmount: { amount: '200.00' },
      discrepancy: '-10.00',
      discrepancyKind: 'SHORT',
      note: 'Customer short-paid GHS 10',
    });
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'cod.remittance_discrepancy.v1' } });
    expect(event.payload).toEqual({
      remittanceId: withNote.data!.recordCashRemittance.id,
      riderId: riderB,
      kind: 'SHORT',
    });
  });

  it('records an adjusting entry (cash with no collections) as an OVER discrepancy', async () => {
    const res = await remit(riderB, '10.00', [], 'Rest of the short remittance');

    expect(res.errors).toBeUndefined();
    expect(res.data!.recordCashRemittance).toMatchObject({
      expectedAmount: { amount: '0.00' },
      discrepancy: '10.00',
      discrepancyKind: 'OVER',
      collections: [],
    });
  });

  it("refuses another rider's collection", async () => {
    const res = await remit(riderA, '30.00', [collections.b3]);

    expect(codeOf(res)).toBe('BAD_REQUEST');
    expect((await prisma.cashCollection.findUniqueOrThrow({ where: { id: collections.b3 } })).remittanceId).toBeNull();
  });

  it('remits a collection only once when two remittances race for it: one wins, the other gets CONFLICT', async () => {
    const results = await Promise.all([
      remit(riderA, '50.25', [collections.a3]),
      remit(riderA, '50.25', [collections.a3]),
    ]);

    expect(results.map((res) => (res.errors ? codeOf(res) : 'OK')).sort()).toEqual(['CONFLICT', 'OK']);
    const again = await remit(riderA, '50.25', [collections.a3]);
    expect([codeOf(again), reasonOf(again)]).toEqual(['CONFLICT', 'COLLECTION_ALREADY_REMITTED']);
    expect(await prisma.cashRemittance.count({ where: { riderId: riderA } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entity: 'CashRemittance' } })).toBe(4);
  });

  it('keeps remittances and remitted collections immutable in the database', async () => {
    const remittance = await prisma.cashRemittance.findFirstOrThrow({ where: { riderId: riderA } });
    const refusal = async (operation: Promise<unknown>) => {
      const error = await operation.then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      return (error as Prisma.PrismaClientKnownRequestError).meta as {
        driverAdapterError: { cause: { originalCode: string; originalMessage: string } };
      };
    };

    const edits = [
      await refusal(prisma.cashRemittance.update({ where: { id: remittance.id }, data: { note: 'edited' } })),
      await refusal(prisma.cashRemittance.delete({ where: { id: remittance.id } })),
      await refusal(prisma.cashCollection.update({ where: { id: collections.a1 }, data: { remittanceId: null } })),
      await refusal(prisma.cashCollection.update({ where: { id: collections.b3 }, data: { amount: '1.00' } })),
    ].map((meta) => meta.driverAdapterError.cause);

    expect(edits.map(({ originalCode }) => originalCode)).toEqual(['23001', '23001', '23001', '23001']);
    expect(edits[0].originalMessage).toMatch(/cannot be changed/);
    expect(edits[1].originalMessage).toMatch(/cannot be deleted/);
    expect(edits[2].originalMessage).toMatch(/only an unremitted collection/);
    expect(edits[3].originalMessage).toMatch(/only an unremitted collection/);
  });

  it('reports per rider: collected, outstanding, remitted, short/over, and COD orders delivered without cash', async () => {
    await order('75.00', ShipmentStatus.DELIVERED);
    await order('40.00', ShipmentStatus.DELIVERED, PaymentMethod.ONLINE);
    const from = startedAt.toISOString();
    const to = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const money = 'amount';
    const figures = `collectionsCount collectedTotal { ${money} } outstandingCount outstandingTotal { ${money} }
      remittancesCount remittedTotal { ${money} } discrepancyCount shortTotal { ${money} } overTotal { ${money} } netDiscrepancy`;

    const res = await gql(`{ codCashReport(input: { from: "${from}", to: "${to}" }) {
      riders { riderId riderName ${figures} }
      pageInfo { totalCount pageSize hasNextPage }
      totals { ${figures} }
      uncollectedDeliveries { count total { amount currency } orders { orderNumber grandTotal { amount } } }
    } }`);

    expect(res.errors).toBeUndefined();
    const report = res.data!.codCashReport;
    const byRider = Object.fromEntries(report.riders.map((rider: { riderId: string }) => [rider.riderId, rider]));
    expect(byRider[riderA]).toMatchObject({
      riderName: 'rider-ama',
      collectionsCount: 3,
      collectedTotal: { amount: '350.25' },
      outstandingCount: 0,
      outstandingTotal: { amount: '0.00' },
      remittancesCount: 2,
      remittedTotal: { amount: '350.25' },
      discrepancyCount: 0,
      netDiscrepancy: '0.00',
    });
    expect(byRider[riderB]).toMatchObject({
      collectionsCount: 3,
      collectedTotal: { amount: '230.00' },
      outstandingCount: 1,
      outstandingTotal: { amount: '30.00' },
      remittancesCount: 2,
      remittedTotal: { amount: '200.00' },
      discrepancyCount: 2,
      shortTotal: { amount: '10.00' },
      overTotal: { amount: '10.00' },
      netDiscrepancy: '0.00',
    });
    expect(report.pageInfo).toEqual({ totalCount: 2, pageSize: 2, hasNextPage: false });
    expect(report.totals).toMatchObject({
      collectionsCount: 6,
      collectedTotal: { amount: '580.25' },
      outstandingCount: 1,
      outstandingTotal: { amount: '30.00' },
      remittancesCount: 4,
      remittedTotal: { amount: '550.25' },
      discrepancyCount: 2,
      netDiscrepancy: '0.00',
    });
    expect(report.uncollectedDeliveries).toMatchObject({ count: 1, total: ghs('75.00') });
    expect(report.uncollectedDeliveries.orders).toEqual([
      { orderNumber: expect.any(Number), grandTotal: { amount: '75.00' } },
    ]);

    const onlyA = await gql(
      `{ codCashReport(input: { from: "${from}", to: "${to}", riderId: "${riderA}" }) { riders { riderId } totals { collectionsCount } } }`,
    );
    expect(onlyA.data!.codCashReport).toEqual({ riders: [{ riderId: riderA }], totals: { collectionsCount: 3 } });
    const empty = await gql(
      `{ codCashReport(input: { from: "2020-01-01T00:00:00Z", to: "2020-02-01T00:00:00Z" }) { riders { riderId } uncollectedDeliveries { count } } }`,
    );
    expect(empty.data!.codCashReport).toEqual({ riders: [], uncollectedDeliveries: { count: 0 } });
  });

  it('refuses staff without cod.cash.manage', async () => {
    const results = await Promise.all([
      remit(riderB, '30.00', [collections.b3], undefined, supportToken),
      gql(`{ unremittedCashCollections(riderId: "${riderB}") { id } }`, supportToken),
      gql('{ cashRemittances { id } }', supportToken),
      gql(
        `{ codCashReport(input: { from: "${startedAt.toISOString()}", to: "${new Date().toISOString()}" }) { riders { riderId } } }`,
        supportToken,
      ),
    ]);

    expect(results.map(codeOf)).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    expect((await prisma.cashCollection.findUniqueOrThrow({ where: { id: collections.b3 } })).remittanceId).toBeNull();
  });

  it('lists remittances newest first, optionally per rider', async () => {
    const all = await gql('{ cashRemittances { riderId } }');
    const ofA = await gql(`{ cashRemittances(riderId: "${riderA}", first: 1) { riderId collections { id } } }`);

    expect(all.data!.cashRemittances).toHaveLength(4);
    expect(ofA.data!.cashRemittances).toEqual([{ riderId: riderA, collections: [{ id: collections.a3 }] }]);
  });
});
