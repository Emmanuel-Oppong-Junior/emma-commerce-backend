import { INestApplication } from '@nestjs/common';
import { FulfillmentType, OrderStatus, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
}

const DELIVERY_FIELDS = `shipmentId status orderNumber recipientName recipientPhone
  address { street area city region landmark ghanaPostGps latitude longitude }
  items { productName sku quantity } amountToCollect { amount currency } assignedAt dispatchedAt deliveredAt`;

// Riders (P5-C.1): the Rider role, assignment by fulfilment staff, and the rider's own deliveries.
describe('Riders (P5-C.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let userToken: string;
  let riderA: { id: string; token: string };
  let riderB: { id: string; token: string };
  let cashier: { id: string; token: string };
  let phoneSeq = 0;

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

  /** A confirmed order with one line of two units and a PENDING shipment of all of it; returns the shipment id. */
  const shipmentFor = async (
    options: { fulfillmentType?: FulfillmentType; paymentMethod?: PaymentMethod } = {},
  ): Promise<{ orderId: string; shipmentId: string; orderNumber: number }> => {
    phoneSeq += 1;
    const fulfillmentType = options.fulfillmentType ?? FulfillmentType.DELIVERY;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        status: OrderStatus.CONFIRMED,
        paymentMethod: options.paymentMethod ?? PaymentMethod.ONLINE,
        fulfillmentType,
        grandTotal: 40,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+2332446${String(phoneSeq).padStart(5, '0')}`,
        ...(fulfillmentType === FulfillmentType.DELIVERY && {
          shippingAddressSnapshot: {
            recipientName: 'Ama Mensah',
            phone: '+233201112222',
            street: '12 Oxford St',
            area: 'Osu',
            city: 'Accra',
            region: 'GREATER_ACCRA',
            landmark: 'Opposite the bank',
            ghanaPostGps: 'GA-123-4567',
            latitude: 5.556,
            longitude: -0.1969,
            country: 'GH',
          },
        }),
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
            sku: 'SEED-1',
            quantity: 2,
            unitListPrice: 20,
            unitDiscount: 0,
            lineTotal: 40,
          },
        },
      },
    });
    const created = await gql(`mutation { createShipment(input: { orderId: "${order.id}" }) { id } }`);
    expect(created.errors).toBeUndefined();
    return { orderId: order.id, shipmentId: created.data!.createShipment.id, orderNumber: order.orderNumber };
  };

  const assign = (shipmentId: string, riderId: string, reason?: string) =>
    gql(
      `mutation { assignShipmentRider(input: { shipmentId: "${shipmentId}", riderId: "${riderId}"${
        reason ? `, reason: "${reason}"` : ''
      } }) { id assignedAt rider { id name } } }`,
    );
  const unassign = (shipmentId: string, reason?: string) =>
    gql(
      `mutation { unassignShipmentRider(input: { shipmentId: "${shipmentId}"${
        reason ? `, reason: "${reason}"` : ''
      } }) { id assignedAt rider { id } } }`,
    );
  const step = (shipmentId: string, status: string) =>
    gql(`mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: ${status} }) { id } }`);
  const start = (shipmentId: string, token: string) =>
    gql(`mutation { startMyDelivery(shipmentId: "${shipmentId}") { shipmentId status dispatchedAt } }`, token);
  const fail = (shipmentId: string, token: string, reason = 'Customer not reachable') =>
    gql(
      `mutation { failMyDelivery(input: { shipmentId: "${shipmentId}", reason: "${reason}" }) { shipmentId status } }`,
      token,
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    adminToken = await signInAdmin(app);
    userToken = await signInUser(app);
    riderA = await staffMember('rider-a@test.local', 'RIDER');
    riderB = await staffMember('rider-b@test.local', 'RIDER');
    cashier = await staffMember('cashier-riders@test.local', 'CASHIER');
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('seeds a system Rider role holding only delivery.ride, without MFA, and lists active riders to fulfilment staff', async () => {
    const role = await prisma.staffRole.findUniqueOrThrow({ where: { key: 'RIDER' } });
    expect(role).toMatchObject({ name: 'Rider', permissions: ['delivery.ride'], isSystem: true, mfaRequired: false });

    const listed = await gql('{ riders { id name } }');
    expect(listed.errors).toBeUndefined();
    expect(listed.data!.riders.map((r: { id: string }) => r.id).sort()).toEqual([riderA.id, riderB.id].sort());
    expect(codeOf(await gql('{ riders { id } }', riderA.token))).toBe('FORBIDDEN');
    expect(codeOf(await gql('{ riders { id } }', userToken))).toBe('FORBIDDEN');
  });

  it('assigns, reassigns before dispatch and unassigns, audited; staff see the rider, customers do not', async () => {
    const { orderId, shipmentId } = await shipmentFor();

    const first = await assign(shipmentId, riderA.id);
    expect(first.errors).toBeUndefined();
    expect(first.data!.assignShipmentRider.rider).toEqual({ id: riderA.id, name: 'rider-a' });
    expect(first.data!.assignShipmentRider.assignedAt).toBeTruthy();
    expect((await assign(shipmentId, riderB.id)).data!.assignShipmentRider.rider.id).toBe(riderB.id);
    expect((await unassign(shipmentId)).data!.unassignShipmentRider).toMatchObject({ assignedAt: null, rider: null });

    const audits = await prisma.auditLog.findMany({
      where: { entity: 'Shipment', entityId: shipmentId, action: { in: ['RIDER_ASSIGN', 'RIDER_UNASSIGN'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => [a.action, a.userId, a.details])).toEqual([
      ['RIDER_ASSIGN', 'seed_admin', { orderId, status: 'PENDING', from: null, to: riderA.id }],
      ['RIDER_ASSIGN', 'seed_admin', { orderId, status: 'PENDING', from: riderA.id, to: riderB.id }],
      ['RIDER_UNASSIGN', 'seed_admin', { orderId, status: 'PENDING', from: riderB.id }],
    ]);

    await assign(shipmentId, riderA.id);
    const customerView = await gql(`{ order(orderId: "${orderId}") { shipments { id rider { id } } } }`, userToken);
    expect(codeOf(customerView)).toBe('FORBIDDEN');
    const staffView = await gql(`{ viewOrder(id: "${orderId}") { shipments { rider { id } assignedAt } } }`);
    expect(staffView.data!.viewOrder.shipments[0].rider).toEqual({ id: riderA.id });
  });

  it('refuses non-riders, pickup shipments, closed shipments and a first rider after dispatch', async () => {
    const { shipmentId } = await shipmentFor();
    const notRider = await assign(shipmentId, cashier.id);
    expect([codeOf(notRider), reasonOf(notRider)]).toEqual(['BAD_REQUEST', 'NOT_A_RIDER']);
    expect(reasonOf(await assign(shipmentId, 'seed_admin'))).toBe('NOT_A_RIDER');
    await prisma.user.update({ where: { id: riderB.id }, data: { isActive: false } });
    expect(reasonOf(await assign(shipmentId, riderB.id))).toBe('NOT_A_RIDER');
    await prisma.user.update({ where: { id: riderB.id }, data: { isActive: true } });

    const pickup = await shipmentFor({ fulfillmentType: FulfillmentType.PICKUP });
    expect(reasonOf(await assign(pickup.shipmentId, riderA.id))).toBe('PICKUP_HAS_NO_RIDER');

    expect((await step(shipmentId, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();
    const late = await assign(shipmentId, riderA.id);
    expect([codeOf(late), reasonOf(late)]).toEqual(['CONFLICT', 'ASSIGN_BEFORE_DISPATCH']);

    const cancelled = await shipmentFor();
    await gql(`mutation { cancelShipment(input: { shipmentId: "${cancelled.shipmentId}" }) { id } }`);
    expect(reasonOf(await assign(cancelled.shipmentId, riderA.id))).toBe('SHIPMENT_CLOSED');
  });

  it('after dispatch replaces the rider only with a reason and never leaves the road without one', async () => {
    const { shipmentId } = await shipmentFor();
    await assign(shipmentId, riderA.id);
    expect((await step(shipmentId, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();

    expect(reasonOf(await assign(shipmentId, riderB.id))).toBe('ASSIGNMENT_REASON_REQUIRED');
    const onTheRoad = await unassign(shipmentId, 'No longer needed');
    expect([codeOf(onTheRoad), reasonOf(onTheRoad)]).toEqual(['CONFLICT', 'RIDER_ON_THE_ROAD']);
    const swapped = await assign(shipmentId, riderB.id, 'Bike broke down');
    expect(swapped.data!.assignShipmentRider.rider.id).toBe(riderB.id);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Shipment', entityId: shipmentId, action: 'RIDER_ASSIGN' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.details).toMatchObject({ from: riderA.id, to: riderB.id, reason: 'Bike broke down' });
  });

  it('shows riders only their own deliveries, with only the fields a delivery needs', async () => {
    const mine = await shipmentFor({ paymentMethod: PaymentMethod.CASH_ON_DELIVERY });
    const theirs = await shipmentFor();
    await assign(mine.shipmentId, riderA.id);
    await assign(theirs.shipmentId, riderB.id);

    const list = await gql(`{ myDeliveries { ${DELIVERY_FIELDS} } }`, riderA.token);
    expect(list.errors).toBeUndefined();
    const ids = list.data!.myDeliveries.map((d: { shipmentId: string }) => d.shipmentId);
    expect(ids).toContain(mine.shipmentId);
    expect(ids).not.toContain(theirs.shipmentId);
    expect(list.data!.myDeliveries.find((d: { shipmentId: string }) => d.shipmentId === mine.shipmentId)).toMatchObject(
      {
        status: 'PENDING',
        orderNumber: mine.orderNumber,
        recipientName: 'Ama Mensah',
        recipientPhone: '+233201112222',
        address: {
          street: '12 Oxford St',
          landmark: 'Opposite the bank',
          ghanaPostGps: 'GA-123-4567',
          latitude: 5.556,
        },
        items: [{ productName: 'Seed product', sku: 'SEED-1', quantity: 2 }],
        amountToCollect: { amount: '40.00', currency: 'GHS' },
      },
    );

    const other = await gql(`{ myDelivery(shipmentId: "${theirs.shipmentId}") { shipmentId } }`, riderA.token);
    const unknown = await gql(`{ myDelivery(shipmentId: "no-such-shipment") { shipmentId } }`, riderA.token);
    expect(codeOf(other)).toBe('NOT_FOUND');
    expect(other.errors![0].message).toBe(unknown.errors![0].message.replace('no-such-shipment', theirs.shipmentId));
    expect(
      (await gql(`{ myDelivery(shipmentId: "${mine.shipmentId}") { shipmentId } }`, riderA.token)).errors,
    ).toBeUndefined();

    // A rider has no way to the order itself, costs or other customers.
    expect(codeOf(await gql(`{ viewOrder(id: "${mine.orderId}") { id } }`, riderA.token))).toBe('FORBIDDEN');
    expect(codeOf(await gql(`{ orderShipments(orderId: "${mine.orderId}") { id } }`, riderA.token))).toBe('FORBIDDEN');
    const leak = await gqlRequest(app, `{ myDeliveries { grandTotal userId } }`, undefined, riderA.token);
    expect(leak.status).toBe(400);
    expect(codeOf(await gql(`{ myDeliveries { shipmentId } }`, cashier.token))).toBe('FORBIDDEN');
    expect(codeOf(await gql(`{ myDeliveries { shipmentId } }`, userToken))).toBe('FORBIDDEN');

    const today = new Date().toISOString().slice(0, 10);
    const dated = await gql(`{ myDeliveries(date: "${today}") { shipmentId } }`, riderA.token);
    expect(dated.data!.myDeliveries.map((d: { shipmentId: string }) => d.shipmentId)).toContain(mine.shipmentId);
    const past = await gql(`{ myDeliveries(date: "2020-01-01") { shipmentId } }`, riderA.token);
    expect(past.data!.myDeliveries).toEqual([]);
    expect(codeOf(await gql(`{ myDeliveries(status: [DELIVERED]) { shipmentId } }`, riderA.token))).toBeUndefined();
  });

  it('lets a rider take their packed shipment out and record a failed attempt, never another rider’s', async () => {
    const { orderId, shipmentId } = await shipmentFor();
    await assign(shipmentId, riderA.id);

    const tooEarly = await start(shipmentId, riderA.token);
    expect(codeOf(tooEarly)).toBe('CONFLICT');
    await step(shipmentId, 'PACKED');
    const stolen = await start(shipmentId, riderB.token);
    expect(codeOf(stolen)).toBe('NOT_FOUND');
    expect(codeOf(await start(shipmentId, cashier.token))).toBe('FORBIDDEN');

    const out = await start(shipmentId, riderA.token);
    expect(out.errors).toBeUndefined();
    expect(out.data!.startMyDelivery).toMatchObject({ shipmentId, status: 'OUT_FOR_DELIVERY' });
    expect(out.data!.startMyDelivery.dispatchedAt).toBeTruthy();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('IN_FULFILMENT');

    expect(codeOf(await fail(shipmentId, riderB.token))).toBe('NOT_FOUND');
    const failed = await fail(shipmentId, riderA.token, 'Gate locked');
    expect(failed.data!.failMyDelivery.status).toBe('FAILED_DELIVERY');
    const event = await prisma.shipmentStatusEvent.findFirstOrThrow({
      where: { shipmentId, to: 'FAILED_DELIVERY' },
    });
    expect(event).toMatchObject({ actorId: riderA.id, reason: 'Gate locked' });
    expect(
      await prisma.auditLog.count({ where: { entity: 'Shipment', entityId: shipmentId, userId: riderA.id } }),
    ).toBe(2);

    const blank = await gql(
      `mutation { failMyDelivery(input: { shipmentId: "${shipmentId}", reason: "  " }) { status } }`,
      riderA.token,
    );
    expect(codeOf(blank)).toBe('BAD_USER_INPUT');
    expect((await start(shipmentId, riderA.token)).data!.startMyDelivery.status).toBe('OUT_FOR_DELIVERY');
  });

  it('takes cash for a delivery only from a rider; at the pickup counter from any staff member', async () => {
    const codOrder = async (fulfillmentType: FulfillmentType) => {
      const order = await prisma.order.create({
        data: {
          orderNumber: await takeOrderNumber(prisma),
          userId: 'seed_user',
          status: OrderStatus.IN_FULFILMENT,
          paymentMethod: PaymentMethod.CASH_ON_DELIVERY,
          fulfillmentType,
          grandTotal: 30,
          currency: 'GHS',
          pricingVersion: 0,
          contactEmail: 'user@example.com',
          contactPhone: '+233244999000',
          shipments: {
            create: {
              status: fulfillmentType === FulfillmentType.PICKUP ? 'READY_FOR_PICKUP' : 'OUT_FOR_DELIVERY',
              dispatchedAt: new Date(Date.now() - 60_000),
            },
          },
        },
      });
      return order.id;
    };
    const recordCod = (orderId: string, riderId: string) =>
      gql(
        `mutation { recordCodPayment(input: { orderId: "${orderId}", riderId: "${riderId}", amount: "30.00" }) { status } }`,
      );

    const delivery = await codOrder(FulfillmentType.DELIVERY);
    const byCashier = await recordCod(delivery, cashier.id);
    expect([codeOf(byCashier), reasonOf(byCashier)]).toEqual(['BAD_REQUEST', 'NOT_A_RIDER']);
    expect(await prisma.cashCollection.count({ where: { orderId: delivery } })).toBe(0);
    expect((await recordCod(delivery, riderA.id)).errors).toBeUndefined();

    const counter = await codOrder(FulfillmentType.PICKUP);
    expect((await recordCod(counter, cashier.id)).errors).toBeUndefined();
  });
});
