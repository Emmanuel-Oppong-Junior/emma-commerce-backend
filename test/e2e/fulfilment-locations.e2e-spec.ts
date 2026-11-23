import { BadRequestException, INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { SerialUnitsRepository } from '../../src/inventory/serials/serial-units.repository';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

const BUYERS = ['seed_user', 'loc_buyer_2'];
const ACCRA_ZONE = 'seed_zone_accra';
const PICKUP = 'loc_pickup_osu';

// P4-A.1 on real Postgres: an order is reserved and fulfilled from the first location of its zone's or pickup point's
// list that can fill every line; customers see what one serving location can sell; locations are managed by staff.
describe('Fulfilment locations (P4-A.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let adminToken: string;
  let clerkToken: string;
  let mainId: string;
  let branchId: string;
  let warehouseId: string;
  const addressOf: Record<string, string> = {};
  let seq = 0;

  /** Signed in as the admin unless `token` is given; '' sends no token. */
  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>) =>
    (await gqlRequest(app, query, variables, token || undefined).expect(200)).body as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };
  const codeOf = (body: { errors?: { extensions?: { code?: string } }[] }) => body.errors?.[0]?.extensions?.code;

  const createLocation = async (name: string, type = 'BRANCH'): Promise<string> => {
    const body = await gql(`mutation { createStockLocation(input: { name: "${name}", type: ${type} }) { id } }`);
    expect(body.errors).toBeUndefined();
    return body.data!.createStockLocation.id as string;
  };

  const restock = async (variantId: string, locationId: string, quantity: number) => {
    const body = await gql(
      `mutation { restockVariant(input: { variantId: "${variantId}", quantity: ${quantity}, locationId: "${locationId}" }) { id locationId } }`,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.restockVariant.locationId).toBe(locationId);
  };

  const setZoneList = async (zoneId: string, locationIds: string[]) => {
    const body = await gql(
      `mutation($ids: [ID!]!) { setShippingZoneFulfilmentLocations(shippingZoneId: "${zoneId}", input: { locationIds: $ids }) { id } }`,
      adminToken,
      { ids: locationIds },
    );
    expect(body.errors).toBeUndefined();
  };

  const newVariant = async (stock: Record<string, number>): Promise<string> => {
    seq += 1;
    const id = `loc_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `loc_prod_${seq}`,
        name: `Location item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `LOC-${seq}`, price: 10, basePrice: 10, lowStockThreshold: 0 } },
      },
    });
    for (const [locationId, quantity] of Object.entries(stock)) await restock(id, locationId, quantity);
    return id;
  };

  const fillCart = async (buyer: string, lines: [string, number][]) => {
    const cart = await prisma.cart.upsert({ where: { userId: buyer }, create: { userId: buyer }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    for (const [variantId, quantity] of lines) {
      await prisma.cartItem.create({
        data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity },
      });
    }
  };

  const deliver = (buyer: string, paymentMethod: PaymentMethod = PaymentMethod.ONLINE) =>
    placeOrderFromCart(orders, buyer, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressOf[buyer],
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod,
    });

  const levelAt = async (variantId: string, locationId: string) => {
    const level = await prisma.stockLevel.findUnique({
      where: { variantId_locationId: { variantId, locationId } },
      select: { onHand: true, reserved: true },
    });
    return level ?? { onHand: 0, reserved: 0 };
  };

  const reservationsOf = (orderId: string) =>
    prisma.stockReservation.findMany({ where: { orderId }, select: { locationId: true, status: true } });

  const availableOf = async (productId: string): Promise<number> => {
    const body = await gql(`{ product(productId: "${productId}") { variants { available } } }`, '');
    expect(body.errors).toBeUndefined();
    return body.data!.product.variants[0].available as number;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.user.create({ data: { id: BUYERS[1], email: 'loc-buyer-2@example.com', name: 'Second' } });
    for (const buyer of BUYERS) {
      const address = await prisma.address.create({
        data: {
          userId: buyer,
          street: '1 Depot St',
          city: 'Accra',
          recipientName: 'Buyer',
          phone: '+233244000000',
          region: 'GREATER_ACCRA',
          country: 'GH',
        },
      });
      addressOf[buyer] = address.id;
    }
    await prisma.pickupLocation.create({
      data: { id: PICKUP, name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
    adminToken = await signInAdmin(app);
    const clerkEmail = 'clerk-locations@test.local';
    clerkToken = (await signUpUser(app, { email: clerkEmail, password: 'Str0ng!Passw0rd', name: 'Clerk' })).accessToken;
    const [clerk, store, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: clerkEmail } }),
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: 'INVENTORY_CLERK' } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: clerk.id, storeId: store.id, roleId: role.id } });

    mainId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    branchId = await createLocation('Osu branch');
    warehouseId = await createLocation('Tema warehouse', 'WAREHOUSE');
  });

  afterAll(() => app.close());

  afterEach(async () => {
    await setZoneList(ACCRA_ZONE, []);
  });

  it('lists the locations to staff with the default first, and refuses staff without the permission to manage them', async () => {
    const listed = await gql('{ stockLocations { id name type isActive isDefault } }', clerkToken);
    const refused = await gql('mutation { createStockLocation(input: { name: "Nope" }) { id } }', clerkToken);
    const refusedList = await gql(
      `mutation { setShippingZoneFulfilmentLocations(shippingZoneId: "${ACCRA_ZONE}", input: { locationIds: [] }) { id } }`,
      clerkToken,
    );

    expect(listed.errors).toBeUndefined();
    expect(listed.data!.stockLocations[0]).toMatchObject({ id: mainId, isDefault: true, isActive: true });
    expect(listed.data!.stockLocations.map((l: { id: string }) => l.id)).toEqual(
      expect.arrayContaining([branchId, warehouseId]),
    );
    expect([codeOf(refused), codeOf(refusedList)]).toEqual(['FORBIDDEN', 'FORBIDDEN']);
    expect(
      await prisma.auditLog.count({ where: { entity: 'StockLocation', entityId: branchId, action: 'CREATE' } }),
    ).toBe(1);
  });

  it('keeps today’s behaviour with an empty list: the order is reserved at the default location', async () => {
    const variantId = await newVariant({ [mainId]: 5, [branchId]: 5 });
    await fillCart(BUYERS[0], [[variantId, 2]]);

    const order = await deliver(BUYERS[0]);

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stockLocationId).toBe(mainId);
    expect(await reservationsOf(order.id)).toEqual([{ locationId: mainId, status: 'ACTIVE' }]);
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('reserves at the first location of the zone list that has every line, and shows the zone list to staff', async () => {
    const variantId = await newVariant({ [mainId]: 5, [branchId]: 5 });
    await setZoneList(ACCRA_ZONE, [branchId, mainId]);
    await fillCart(BUYERS[0], [[variantId, 2]]);

    const order = await deliver(BUYERS[0]);
    const zones = await gql('{ shippingZones { id fulfilmentLocations { id } } }');

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).stockLocationId).toBe(branchId);
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 5, reserved: 2 });
    expect(await levelAt(variantId, mainId)).toEqual({ onHand: 5, reserved: 0 });
    expect(zones.data!.shippingZones.find((z: { id: string }) => z.id === ACCRA_ZONE).fulfilmentLocations).toEqual([
      { id: branchId },
      { id: mainId },
    ]);
  });

  it('falls back to the next location when the first lacks one line, keeping the whole order at one location', async () => {
    const both = await newVariant({ [branchId]: 5, [mainId]: 5 });
    const mainOnly = await newVariant({ [mainId]: 5 });
    await setZoneList(ACCRA_ZONE, [branchId, mainId]);
    await fillCart(BUYERS[0], [
      [both, 1],
      [mainOnly, 1],
    ]);

    const order = await deliver(BUYERS[0]);

    expect(await reservationsOf(order.id)).toEqual([
      { locationId: mainId, status: 'ACTIVE' },
      { locationId: mainId, status: 'ACTIVE' },
    ]);
    expect(await levelAt(both, branchId)).toEqual({ onHand: 5, reserved: 0 });
  });

  it('refuses when no single location can fill the order, and when a line is short everywhere', async () => {
    const branchOnly = await newVariant({ [branchId]: 5 });
    const mainOnly = await newVariant({ [mainId]: 5 });
    await setZoneList(ACCRA_ZONE, [branchId, mainId]);
    await fillCart(BUYERS[0], [
      [branchOnly, 1],
      [mainOnly, 1],
    ]);

    await expect(deliver(BUYERS[0])).rejects.toThrow(/not all in stock at one location/);

    await fillCart(BUYERS[0], [[mainOnly, 6]]);
    await expect(deliver(BUYERS[0])).rejects.toThrow(BadRequestException);
    expect(await prisma.stockReservation.count({ where: { variantId: { in: [branchOnly, mainOnly] } } })).toBe(0);
  });

  it('never counts a location the zone does not list', async () => {
    const variantId = await newVariant({ [warehouseId]: 9 });
    await setZoneList(ACCRA_ZONE, [branchId]);
    await fillCart(BUYERS[0], [[variantId, 1]]);

    await expect(deliver(BUYERS[0])).rejects.toThrow(BadRequestException);
  });

  it('takes the second location when two customers race for the last unit of the first', async () => {
    const variantId = await newVariant({ [branchId]: 1, [mainId]: 1 });
    await setZoneList(ACCRA_ZONE, [branchId, mainId]);
    for (const buyer of BUYERS) await fillCart(buyer, [[variantId, 1]]);

    const placed = await Promise.all(BUYERS.map((buyer) => deliver(buyer)));

    const locations = await prisma.order.findMany({
      where: { id: { in: placed.map((order) => order.id) } },
      select: { stockLocationId: true },
    });
    expect(locations.map((order) => order.stockLocationId).sort()).toEqual([branchId, mainId].sort());
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 1, reserved: 1 });
    expect(await levelAt(variantId, mainId)).toEqual({ onHand: 1, reserved: 1 });
  });

  it('consumes an online order at its location on payment and releases a cancelled one there', async () => {
    const variantId = await newVariant({ [branchId]: 5 });
    await setZoneList(ACCRA_ZONE, [branchId]);
    await fillCart(BUYERS[0], [[variantId, 2]]);
    const paid = await deliver(BUYERS[0]);
    await fillCart(BUYERS[0], [[variantId, 1]]);
    const cancelled = await deliver(BUYERS[0]);

    const { paymentId, reference } = await seedPaymentAttempt(prisma, {
      orderId: paid.id,
      status: 'PENDING',
      amount: Number(paid.grandTotal),
    });
    const verified = { reference, status: 'success', amount: Number(paid.grandTotal) * 100, currency: 'GHS' };
    await payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
    await orders.cancelOrder(BUYERS[0], cancelled.id);

    expect(await reservationsOf(paid.id)).toEqual([{ locationId: branchId, status: 'CONSUMED' }]);
    expect(await reservationsOf(cancelled.id)).toEqual([{ locationId: branchId, status: 'RELEASED' }]);
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 3, reserved: 0 });
    const reasons = await prisma.stockMovement.findMany({
      where: { variantId, refType: 'Order' },
      select: { locationId: true },
    });
    expect(new Set(reasons.map((m) => m.locationId))).toEqual(new Set([branchId]));
  });

  it('consumes a cash-on-delivery order at its location on dispatch, and restocks its return there', async () => {
    const variantId = await newVariant({ [branchId]: 4, [mainId]: 4 });
    await setZoneList(ACCRA_ZONE, [branchId]);
    await verifyPhoneForCod(prisma, BUYERS[0]);
    await fillCart(BUYERS[0], [[variantId, 2]]);
    const order = await deliver(BUYERS[0], PaymentMethod.CASH_ON_DELIVERY);

    const shipped = await gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, order.id)}", status: OUT_FOR_DELIVERY }) { status } }`,
    );
    const returnRequest = await prisma.returnRequest.create({
      data: { orderId: order.id, userId: BUYERS[0], reason: 'Wrong size' },
    });
    const restocked = await gql(
      `mutation { restockVariant(input: { variantId: "${variantId}", quantity: 1, returnRequestId: "${returnRequest.id}" }) { locationId reason } }`,
    );

    expect(shipped.errors).toBeUndefined();
    expect(await reservationsOf(order.id)).toEqual([{ locationId: branchId, status: 'CONSUMED' }]);
    expect(restocked.data!.restockVariant).toEqual({ locationId: branchId, reason: 'RETURN_RESTOCK' });
    expect(await levelAt(variantId, branchId)).toEqual({ onHand: 3, reserved: 0 });
    expect(await levelAt(variantId, mainId)).toEqual({ onHand: 4, reserved: 0 });
  });

  it('fulfils a pickup order from the pickup point’s own location', async () => {
    const pointId = await createLocation('Osu counter', 'PICKUP_POINT');
    const variantId = await newVariant({ [mainId]: 5, [pointId]: 5 });
    const set = await gql(
      `mutation { setPickupLocationFulfilmentLocations(pickupLocationId: "${PICKUP}", input: { locationIds: ["${pointId}"] }) { id } }`,
    );
    await fillCart(BUYERS[0], [[variantId, 1]]);

    const order = await placeOrderFromCart(orders, BUYERS[0], {
      fulfillmentType: FulfillmentType.PICKUP,
      pickupLocationId: PICKUP,
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
    });

    expect(set.data!.setPickupLocationFulfilmentLocations).toEqual([{ id: pointId }]);
    expect(await reservationsOf(order.id)).toEqual([{ locationId: pointId, status: 'ACTIVE' }]);
  });

  it('shows customers what one serving location can sell, never the sum, and hides unlisted or inactive stock', async () => {
    const outsider = await createLocation('Unlisted store');
    const variantId = await newVariant({ [mainId]: 3, [branchId]: 7, [outsider]: 50 });
    const productId = variantId.replace('var', 'prod');
    await setZoneList(ACCRA_ZONE, [branchId, mainId]);

    const listed = await availableOf(productId);
    const staffView = await gql(
      `{ product(productId: "${productId}") { totalStock variants { onHand stockLevels { locationId available } } } }`,
    );
    await gql(`mutation { updateStockLocation(id: "${branchId}", input: { isActive: false }) { id } }`);
    const branchClosed = await availableOf(productId);
    await gql(`mutation { updateStockLocation(id: "${branchId}", input: { isActive: true }) { id } }`);
    await setZoneList(ACCRA_ZONE, []);
    const branchUnlisted = await availableOf(productId);
    const denied = await gql(`{ product(productId: "${productId}") { variants { stockLevels { onHand } } } }`, '');

    expect(listed).toBe(7);
    expect(staffView.data!.product.totalStock).toBe(7);
    expect(staffView.data!.product.variants[0].onHand).toBe(60);
    expect(staffView.data!.product.variants[0].stockLevels).toEqual(
      expect.arrayContaining([
        { locationId: mainId, available: 3 },
        { locationId: branchId, available: 7 },
        { locationId: outsider, available: 50 },
      ]),
    );
    expect(branchClosed).toBe(3);
    expect(branchUnlisted).toBe(3);
    expect(codeOf(denied)).toBe('FORBIDDEN');
  });

  it('skips an inactive listed location, falling back to the default when none of the list is active', async () => {
    const variantId = await newVariant({ [branchId]: 5, [mainId]: 5 });
    await setZoneList(ACCRA_ZONE, [branchId]);
    await gql(`mutation { updateStockLocation(id: "${branchId}", input: { isActive: false }) { id } }`);
    await fillCart(BUYERS[0], [[variantId, 1]]);

    const order = await deliver(BUYERS[0]);
    await gql(`mutation { updateStockLocation(id: "${branchId}", input: { isActive: true }) { id } }`);

    expect(await reservationsOf(order.id)).toEqual([{ locationId: mainId, status: 'ACTIVE' }]);
  });

  it('keeps the default active, moves the default flag, and deletes only locations without history', async () => {
    const deactivateDefault = await gql(
      `mutation { updateStockLocation(id: "${mainId}", input: { isActive: false }) { id } }`,
    );
    const deleteDefault = await gql(`mutation { deleteStockLocation(id: "${mainId}") { id } }`);
    const deleteUsed = await gql(`mutation { deleteStockLocation(id: "${branchId}") { id } }`);
    const unused = await createLocation('Pop-up stall');
    const deleteUnused = await gql(`mutation { deleteStockLocation(id: "${unused}") { id } }`);
    const moved = await gql(
      `mutation { updateStockLocation(id: "${warehouseId}", input: { isDefault: true }) { isDefault } }`,
    );
    const defaults = await prisma.stockLocation.findMany({ where: { isDefault: true }, select: { id: true } });
    const restored = await gql(`mutation { updateStockLocation(id: "${mainId}", input: { isDefault: true }) { id } }`);

    expect(codeOf(deactivateDefault)).toBe('BAD_REQUEST');
    expect(codeOf(deleteDefault)).toBe('CONFLICT');
    expect(codeOf(deleteUsed)).toBe('CONFLICT');
    expect(deleteUnused.errors).toBeUndefined();
    expect(await prisma.stockLocation.count({ where: { id: unused } })).toBe(0);
    expect(moved.data!.updateStockLocation).toEqual({ isDefault: true });
    expect(defaults).toEqual([{ id: warehouseId }]);
    expect(restored.errors).toBeUndefined();
    expect(
      await prisma.auditLog.count({ where: { entity: 'StockLocation', action: { in: ['UPDATE', 'DELETE'] } } }),
    ).toBeGreaterThanOrEqual(3);
  });

  it('leaves every stock level reconciled with its ledger per location', async () => {
    const task = new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
      app.get(SerialUnitsRepository),
    );

    await expect(task.reconcile()).resolves.toEqual([]);
  });
});
