import { INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { SerialUnitsRepository } from '../../src/inventory/serials/serial-units.repository';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, stockOf, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

type GqlBody = { data?: Record<string, any>; errors?: { message: string; extensions?: Record<string, unknown> }[] };

const BUYER = 'seed_user';

/** A valid IMEI: "35" + `n` padded to 12 digits + its Luhn check digit. */
function imei(n: number): string {
  const body = `35${String(n).padStart(12, '0')}`;
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    let digit = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return `${body}${(10 - (sum % 10)) % 10}`;
}

// P4-D.1 accept criteria on real Postgres: serials captured at receipt, assigned at pick, sold at dispatch, warranty
// from delivery, and every other stock path of a serial-tracked variant naming its units.
describe('Serial units (P4-D.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let managerToken: string;
  let clerkToken: string;
  let supportToken: string;
  let catalogToken: string;
  let customerToken: string;
  let addressId: string;
  let mainId: string;
  let branchId: string;
  let seq = 0;
  let serialNo = 0;

  const gql = async (query: string, token = managerToken, variables?: Record<string, unknown>): Promise<GqlBody> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body as GqlBody;
  const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;
  const reasonOf = (body: GqlBody) => body.errors?.[0]?.extensions?.reason;
  const nextImeis = (count: number) => Array.from({ length: count }, () => imei((serialNo += 1)));

  const staffMember = async (email: string, roleKey: string): Promise<string> => {
    const { accessToken } = await signUpUser(app, { email, password: 'Str0ng!Passw0rd', name: email.split('@')[0] });
    const [user, store, role] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email } }),
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: roleKey } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    return accessToken;
  };

  /** A phone tracked by IMEI with a 12-month warranty and no stock. */
  const newPhone = async (): Promise<string> => {
    seq += 1;
    const id = `sn_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `sn_prod_${seq}`,
        name: `Phone ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        trackSerials: true,
        serialFormat: 'IMEI',
        warrantyMonths: 12,
        variants: { create: { id, sku: `SN-${seq}`, price: 100, basePrice: 100, lowStockThreshold: 0 } },
      },
    });
    return id;
  };

  const restock = (variantId: string, serials: string[] | null, quantity = serials?.length ?? 1, extra = {}) =>
    gql(
      'mutation($input: RestockVariantInput!) { restockVariant(input: $input) { id onHandDelta reason locationId } }',
      managerToken,
      { input: { variantId, quantity, ...(serials && { serials }), ...extra } },
    );

  const stockedPhone = async (count: number, extra = {}): Promise<{ variantId: string; serials: string[] }> => {
    const variantId = await newPhone();
    const serials = nextImeis(count);
    const body = await restock(variantId, serials, count, extra);
    expect(body.errors).toBeUndefined();
    return { variantId, serials };
  };

  const unit = (variantId: string, serial: string) =>
    prisma.serialUnit.findUniqueOrThrow({ where: { variantId_serial: { variantId, serial } } });

  const placeOrder = async (variantId: string, quantity: number, paymentMethod: PaymentMethod) => {
    const cart = await prisma.cart.upsert({ where: { userId: BUYER }, create: { userId: BUYER }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity },
    });
    const order = await placeOrderFromCart(orders, BUYER, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressId,
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod,
    });
    return { orderId: order.id, orderItemId: order.items[0].id, grandTotal: order.grandTotal.toFixed(2) };
  };

  const pay = async (orderId: string, amount: number) => {
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };
    await payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
  };

  const ship = async (orderId: string, status: string) =>
    gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, orderId)}", status: ${status} }) { status } }`,
    );

  /** The order line's item in its order's shipment (serials are assigned per shipment line since P5-B.1). */
  const shipmentItemOf = async (orderItemId: string) => {
    const { orderId } = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
    const shipmentId = await shipmentOf(prisma, orderId);
    return (await prisma.shipmentItem.findFirstOrThrow({ where: { shipmentId, orderItemId } })).id;
  };
  const assign = async (orderItemId: string, serials: string[], token = managerToken) =>
    gql(
      'mutation($input: ShipmentItemSerialsInput!) { assignShipmentItemSerials(input: $input) { id items { id serials { serial status } } } }',
      token,
      { input: { shipmentItemId: await shipmentItemOf(orderItemId), serials } },
    );
  const unassign = async (orderItemId: string, serials: string[]) =>
    gql(
      'mutation($input: ShipmentItemSerialsInput!) { unassignShipmentItemSerials(input: $input) { id } }',
      managerToken,
      { input: { shipmentItemId: await shipmentItemOf(orderItemId), serials } },
    );

  const lookup = (serial: string, token = supportToken) =>
    gql(
      `{ serialUnitLookup(serial: "${serial}") { sku productName orderId orderNumber customerId
         unit { serial status locationId orderItemId soldAt warrantyStartsAt warrantyEndsAt } } }`,
      token,
    );

  const reconcile = () =>
    new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
      app.get(SerialUnitsRepository),
    ).reconcile();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await verifyPhoneForCod(prisma);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
    clerkToken = await staffMember('clerk-serials@test.local', 'INVENTORY_CLERK');
    supportToken = await staffMember('support-serials@test.local', 'SUPPORT');
    await staffMember('rider-serials@test.local', 'RIDER');
    await prisma.staffRole.create({
      data: { key: 'SERIALS_CATALOG_ONLY', name: 'Catalogue only', permissions: ['catalog.product.read'] },
    });
    catalogToken = await staffMember('catalog-serials@test.local', 'SERIALS_CATALOG_ONLY');
    mainId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    const created = await gql('mutation { createStockLocation(input: { name: "Tema branch", type: BRANCH }) { id } }');
    expect(created.errors).toBeUndefined();
    branchId = created.data!.createStockLocation.id as string;
    addressId = (
      await prisma.address.create({
        data: {
          userId: BUYER,
          street: '1 Serial St',
          city: 'Accra',
          recipientName: 'Buyer',
          phone: '+233244000000',
          region: 'GREATER_ACCRA',
          country: 'GH',
        },
      })
    ).id;
  });

  afterAll(() => app.close());

  describe('receipt', () => {
    it('needs exactly one valid, new serial per unit; stores them normalised, with history and audit', async () => {
      const variantId = await newPhone();
      const [a, b] = nextImeis(2);

      const missing = await restock(variantId, null, 2);
      expect(codeOf(missing)).toBe('BAD_REQUEST');
      expect(reasonOf(missing)).toBe('SERIALS_REQUIRED');
      expect(codeOf(await restock(variantId, [a, b, nextImeis(1)[0]], 2))).toBe('BAD_REQUEST');
      expect(codeOf(await restock(variantId, [a, a], 2))).toBe('BAD_REQUEST');
      const badImei = await restock(variantId, [a, `${b.slice(0, 14)}${(Number(b[14]) + 1) % 10}`], 2);
      expect(codeOf(badImei)).toBe('BAD_REQUEST');
      expect(badImei.errors![0].message).toContain('check digit');
      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 0 });

      const spaced = `${a.slice(0, 2)}-${a.slice(2, 8)} ${a.slice(8)}`;
      const received = await restock(variantId, [spaced, b], 2);

      expect(received.errors).toBeUndefined();
      const movementId = received.data!.restockVariant.id as string;
      const units = await prisma.serialUnit.findMany({ where: { variantId }, orderBy: { serial: 'asc' } });
      expect(units.map((u) => [u.serial, u.status, u.locationId])).toEqual(
        [a, b].sort().map((serial) => [serial, 'IN_STOCK', mainId]),
      );
      const events = await prisma.serialUnitEvent.findMany({ where: { serialUnitId: { in: units.map((u) => u.id) } } });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.from === null && e.to === 'IN_STOCK' && e.movementId === movementId)).toBe(true);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entity: 'Variant', entityId: variantId, action: 'STOCK_ADJUSTMENT' },
      });
      expect((audit.details as { serials: string[] }).serials.sort()).toEqual([a, b].sort());
      await expect(
        prisma.$executeRaw`UPDATE "SerialUnitEvent" SET "note" = 'x' WHERE "id" = ${events[0].id}`,
      ).rejects.toThrow(/append-only/);

      const again = await restock(variantId, [a, nextImeis(1)[0]], 2);
      expect(codeOf(again)).toBe('CONFLICT');
      expect(reasonOf(again)).toBe('SERIAL_ALREADY_KNOWN');
      expect(again.errors![0].extensions!.serials).toEqual([a]);
      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 2 });
    });

    it('leaves untracked variants unchanged and refuses serials on them', async () => {
      const before = await stockOf(prisma, 'seed_var1');

      expect((await restock('seed_var1', null, 3)).errors).toBeUndefined();
      expect(codeOf(await restock('seed_var1', ['ABC1'], 1))).toBe('BAD_REQUEST');
      expect(await stockOf(prisma, 'seed_var1')).toMatchObject({ onHand: before.onHand + 3 });
      expect(await prisma.serialUnit.count({ where: { variantId: 'seed_var1' } })).toBe(0);
    });
  });

  describe('tracking flag', () => {
    it('turns on only without untracked stock, off only without units in stock; no opening stock when tracked', async () => {
      const update = (productId: string, input: string) =>
        gql(
          `mutation { updateProduct(productId: "${productId}", updateProductInput: { ${input} }) { id trackSerials } }`,
        );

      const onWithStock = await update('seed_prod2', 'trackSerials: true');
      expect(codeOf(onWithStock)).toBe('BAD_REQUEST');
      expect(onWithStock.errors![0].message).toContain('on hand');

      seq += 1;
      await prisma.product.create({
        data: {
          id: `sn_prod_${seq}`,
          name: 'Untracked, empty',
          images: [],
          variants: { create: { id: `sn_var_${seq}`, sku: `SN-${seq}`, price: 5, basePrice: 5 } },
        },
      });
      const turnedOn = await update(`sn_prod_${seq}`, 'trackSerials: true, serialFormat: FREE_TEXT, warrantyMonths: 6');
      expect(turnedOn.errors).toBeUndefined();
      expect(turnedOn.data!.updateProduct.trackSerials).toBe(true);

      const { variantId } = await stockedPhone(1);
      const offWithUnits = await update(variantId.replace('var', 'prod'), 'trackSerials: false');
      expect(codeOf(offWithUnits)).toBe('BAD_REQUEST');
      expect(offWithUnits.errors![0].message).toContain('1 serial unit is');

      const opening = await gql(
        `mutation { createVariant(input: { productId: "${variantId.replace('var', 'prod')}", basePrice: "100", quantity: 2 }) { id } }`,
      );
      expect(codeOf(opening)).toBe('BAD_REQUEST');
      expect(opening.errors![0].message).toContain('restockVariant');
    });
  });

  describe('assignment at pick and dispatch', () => {
    it('cash on delivery: assigns at PICKING/PACKED, refuses dispatch until complete, sells, warranty at delivery', async () => {
      const { variantId, serials } = await stockedPhone(3);
      const { orderId, orderItemId, grandTotal } = await placeOrder(variantId, 2, PaymentMethod.CASH_ON_DELIVERY);

      const early = await assign(orderItemId, [serials[0]]);
      expect(codeOf(early)).toBe('CONFLICT');
      expect(early.errors![0].message).toContain('PICKING or PACKED');

      expect((await ship(orderId, 'PICKING')).errors).toBeUndefined();
      const first = await assign(orderItemId, [serials[0]]);
      expect(first.errors).toBeUndefined();
      expect(first.data!.assignShipmentItemSerials.items[0].serials).toEqual([
        { serial: serials[0], status: 'ASSIGNED' },
      ]);

      const notReady = await ship(orderId, 'OUT_FOR_DELIVERY');
      expect(codeOf(notReady)).toBe('BAD_REQUEST');
      expect(reasonOf(notReady)).toBe('SERIALS_NOT_ASSIGNED');

      const unknown = await assign(orderItemId, [imei(999_999)]);
      expect(codeOf(unknown)).toBe('CONFLICT');
      expect(reasonOf(unknown)).toBe('SERIAL_NOT_AVAILABLE');
      expect(codeOf(await assign(orderItemId, [serials[1], serials[2]]))).toBe('BAD_REQUEST');
      expect((await assign(orderItemId, [serials[1]])).errors).toBeUndefined();
      expect((await unassign(orderItemId, [serials[1]])).errors).toBeUndefined();
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'IN_STOCK', orderItemId: null });
      expect((await ship(orderId, 'PACKED')).errors).toBeUndefined();
      expect((await assign(orderItemId, [serials[2]])).errors).toBeUndefined();

      expect((await ship(orderId, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();

      for (const serial of [serials[0], serials[2]]) {
        expect(await unit(variantId, serial)).toMatchObject({ status: 'SOLD', locationId: null, orderItemId });
      }
      expect((await unit(variantId, serials[0])).soldAt).toBeInstanceOf(Date);
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'IN_STOCK', locationId: mainId });
      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 1, reserved: 0 });

      const rider = await prisma.user.findUniqueOrThrow({ where: { email: 'rider-serials@test.local' } });
      const delivered = await gql(
        `mutation { recordCodPayment(input: { orderId: "${orderId}", riderId: "${rider.id}", amount: "${grandTotal}" }) { id } }`,
      );
      expect(delivered.errors).toBeUndefined();
      const sold = await unit(variantId, serials[0]);
      expect(sold.warrantyStartsAt).toBeInstanceOf(Date);
      const expectedEnd = new Date(sold.warrantyStartsAt!);
      expectedEnd.setUTCFullYear(expectedEnd.getUTCFullYear() + 1);
      expect(sold.warrantyEndsAt).toEqual(expectedEnd);

      const mine = await gql(
        `{ order(orderId: "${orderId}") { items { serials { serial status warrantyEndsAt } } } }`,
        customerToken,
      );
      expect(mine.errors).toBeUndefined();
      expect(mine.data!.order.items[0].serials).toEqual(
        [serials[0], serials[2]].sort().map((serial) => ({
          serial,
          status: 'SOLD',
          warrantyEndsAt: expectedEnd.toISOString(),
        })),
      );

      const found = await lookup(serials[0].replace(/(\d{5})/, '$1 '));
      expect(found.errors).toBeUndefined();
      expect(found.data!.serialUnitLookup).toEqual([
        expect.objectContaining({
          sku: expect.any(String),
          orderId,
          customerId: BUYER,
          unit: expect.objectContaining({
            serial: serials[0],
            status: 'SOLD',
            warrantyEndsAt: expectedEnd.toISOString(),
          }),
        }),
      ]);

      const audits = await prisma.auditLog.findMany({ where: { entity: 'OrderItem', entityId: orderItemId } });
      expect(audits.map((a) => (a.details as { change: string }).change).sort()).toEqual([
        'SERIALS_ASSIGNED',
        'SERIALS_ASSIGNED',
        'SERIALS_ASSIGNED',
        'SERIALS_UNASSIGNED',
      ]);
    });

    it('online: units stay on the shelf after payment until dispatch; the ledger and the units agree throughout', async () => {
      const { variantId, serials } = await stockedPhone(2);
      const { orderId, orderItemId, grandTotal } = await placeOrder(variantId, 1, PaymentMethod.ONLINE);
      await pay(orderId, Number(grandTotal));

      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 1, reserved: 0 });
      expect(await prisma.serialUnit.count({ where: { variantId, status: 'IN_STOCK' } })).toBe(2);
      expect(await reconcile()).toEqual([]);

      expect((await ship(orderId, 'PICKING')).errors).toBeUndefined();
      expect(reasonOf(await ship(orderId, 'OUT_FOR_DELIVERY'))).toBe('SERIALS_NOT_ASSIGNED');
      expect((await assign(orderItemId, [serials[1]])).errors).toBeUndefined();
      expect(await reconcile()).toEqual([]);
      expect((await ship(orderId, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'SOLD', warrantyStartsAt: null });
      expect(await reconcile()).toEqual([]);

      expect((await ship(orderId, 'DELIVERED')).errors).toBeUndefined();
      expect((await unit(variantId, serials[1])).warrantyEndsAt).toBeInstanceOf(Date);
    });

    it('split shipments: serials per shipment line, each dispatched and warrantied with its own shipment', async () => {
      const { variantId, serials } = await stockedPhone(2);
      const { orderId, orderItemId, grandTotal } = await placeOrder(variantId, 2, PaymentMethod.ONLINE);
      await pay(orderId, Number(grandTotal));
      const create = async () => {
        const body = await gql(
          `mutation { createShipment(input: { orderId: "${orderId}", items: [{ orderItemId: "${orderItemId}", quantity: 1 }] }) { id items { id } } }`,
        );
        expect(body.errors).toBeUndefined();
        return body.data!.createShipment as { id: string; items: { id: string }[] };
      };
      const first = await create();
      const second = await create();
      const step = (shipmentId: string, status: string) =>
        gql(`mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: ${status} }) { status } }`);
      const assignTo = (shipmentItemId: string, list: string[]) =>
        gql(
          'mutation($input: ShipmentItemSerialsInput!) { assignShipmentItemSerials(input: $input) { id } }',
          managerToken,
          {
            input: { shipmentItemId, serials: list },
          },
        );

      await step(first.id, 'PICKING');
      await step(second.id, 'PICKING');
      expect(codeOf(await assignTo(first.items[0].id, serials))).toBe('BAD_REQUEST');
      expect((await assignTo(first.items[0].id, [serials[0]])).errors).toBeUndefined();
      expect(reasonOf(await step(second.id, 'OUT_FOR_DELIVERY'))).toBe('SERIALS_NOT_ASSIGNED');
      expect((await step(first.id, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();
      expect(await unit(variantId, serials[0])).toMatchObject({ status: 'SOLD', shipmentItemId: first.items[0].id });
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'IN_STOCK' });
      expect(await reconcile()).toEqual([]);

      expect((await step(first.id, 'DELIVERED')).errors).toBeUndefined();
      expect((await unit(variantId, serials[0])).warrantyStartsAt).toBeInstanceOf(Date);

      expect((await assignTo(second.items[0].id, [serials[1]])).errors).toBeUndefined();
      expect((await step(second.id, 'OUT_FOR_DELIVERY')).errors).toBeUndefined();
      expect((await unit(variantId, serials[1])).warrantyStartsAt).toBeNull();
      expect(await reconcile()).toEqual([]);
      expect((await step(second.id, 'DELIVERED')).errors).toBeUndefined();
      expect((await unit(variantId, serials[1])).warrantyStartsAt).toBeInstanceOf(Date);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
    });

    it('puts the units picked for a cancelled shipment back on the shelf', async () => {
      const { variantId, serials } = await stockedPhone(1);
      const { orderId, orderItemId } = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      await ship(orderId, 'PICKING');
      expect((await assign(orderItemId, serials)).errors).toBeUndefined();

      const shipmentId = await shipmentOf(prisma, orderId);
      const cancelled = await gql(`mutation { cancelShipment(input: { shipmentId: "${shipmentId}" }) { id } }`);

      expect(cancelled.errors).toBeUndefined();
      expect(await unit(variantId, serials[0])).toMatchObject({
        status: 'IN_STOCK',
        orderItemId: null,
        shipmentItemId: null,
        locationId: mainId,
      });
      expect(await reconcile()).toEqual([]);
    });

    it('lets only one of two orders racing for the same unit take it', async () => {
      const { variantId, serials } = await stockedPhone(2);
      const first = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      const second = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      await ship(first.orderId, 'PICKING');
      await ship(second.orderId, 'PICKING');

      const results = await Promise.all([
        assign(first.orderItemId, [serials[0]]),
        assign(second.orderItemId, [serials[0]]),
      ]);

      expect(results.filter((body) => !body.errors)).toHaveLength(1);
      const loser = results.find((body) => body.errors)!;
      expect(codeOf(loser)).toBe('CONFLICT');
      expect(await prisma.serialUnit.count({ where: { variantId, status: 'ASSIGNED' } })).toBe(1);
    });

    it('frees assigned units when the order is cancelled before dispatch', async () => {
      const { variantId, serials } = await stockedPhone(1);
      const { orderId, orderItemId } = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      await ship(orderId, 'PICKING');
      expect((await assign(orderItemId, serials)).errors).toBeUndefined();

      const cancelled = await gql(`mutation { adminCancelOrder(orderId: "${orderId}") { status } }`);

      expect(cancelled.errors).toBeUndefined();
      expect(await unit(variantId, serials[0])).toMatchObject({
        status: 'IN_STOCK',
        orderItemId: null,
        locationId: mainId,
      });
      expect(await reconcile()).toEqual([]);
    });

    it('limits assignment to order.fulfil and lookups to order.view', async () => {
      const { variantId, serials } = await stockedPhone(1);
      const { orderId, orderItemId } = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      await ship(orderId, 'PICKING');

      expect(codeOf(await assign(orderItemId, serials, supportToken))).toBe('FORBIDDEN');
      expect(codeOf(await assign(orderItemId, serials, catalogToken))).toBe('FORBIDDEN');
      expect(codeOf(await assign(orderItemId, serials, customerToken))).toBe('FORBIDDEN');
      expect(codeOf(await lookup(serials[0], catalogToken))).toBe('FORBIDDEN');
      expect(codeOf(await lookup(serials[0], customerToken))).toBe('FORBIDDEN');
      expect((await lookup(serials[0], supportToken)).data!.serialUnitLookup).toHaveLength(1);
      expect((await assign(orderItemId, serials, clerkToken)).errors).toBeUndefined();
    });
  });

  describe('other stock paths', () => {
    it('writes off named units, refuses assigned ones, and brings a found unit back', async () => {
      const { variantId, serials } = await stockedPhone(3);
      const { orderId, orderItemId } = await placeOrder(variantId, 1, PaymentMethod.CASH_ON_DELIVERY);
      await ship(orderId, 'PICKING');
      await assign(orderItemId, [serials[2]]);
      const adjust = (delta: number, reason: string, list?: string[]) =>
        gql(
          'mutation($input: AdjustVariantStockInput!) { adjustVariantStock(input: $input) { id onHandDelta } }',
          clerkToken,
          { input: { variantId, delta, reason, ...(list && { serials: list }) } },
        );

      expect(reasonOf(await adjust(-1, 'DAMAGED'))).toBe('SERIALS_REQUIRED');
      expect(reasonOf(await adjust(-1, 'DAMAGED', [serials[2]]))).toBe('SERIAL_NOT_AVAILABLE');
      expect((await adjust(-1, 'DAMAGED', [serials[0]])).errors).toBeUndefined();
      expect(await unit(variantId, serials[0])).toMatchObject({ status: 'WRITTEN_OFF', locationId: null });

      expect((await adjust(1, 'FOUND', [serials[0]])).errors).toBeUndefined();
      expect(await unit(variantId, serials[0])).toMatchObject({ status: 'IN_STOCK', locationId: mainId });
      const extra = nextImeis(1);
      expect((await adjust(1, 'FOUND', extra)).errors).toBeUndefined();
      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 4 });
      expect(await reconcile()).toEqual([]);
    });

    it('moves units on a transfer and writes off the ones missing on arrival', async () => {
      const { variantId, serials } = await stockedPhone(3);
      const created = await gql(
        'mutation($input: CreateStockTransferInput!) { createStockTransfer(input: $input) { id } }',
        managerToken,
        { input: { fromLocationId: mainId, toLocationId: branchId, lines: [{ variantId, quantity: 3 }] } },
      );
      const transferId = created.data!.createStockTransfer.id as string;
      const dispatch = (lines?: { variantId: string; serials: string[] }[]) =>
        gql(
          `mutation($input: DispatchStockTransferInput) { dispatchStockTransfer(id: "${transferId}", input: $input) { status } }`,
          managerToken,
          { input: lines ? { lines } : null },
        );

      expect(reasonOf(await dispatch())).toBe('SERIALS_REQUIRED');
      expect((await dispatch([{ variantId, serials }])).errors).toBeUndefined();
      expect(await prisma.serialUnit.count({ where: { variantId, status: 'IN_TRANSIT', locationId: null } })).toBe(3);
      expect(await reconcile()).toEqual([]);

      const received = await gql(
        `mutation($input: ReceiveStockTransferInput) { receiveStockTransfer(id: "${transferId}", input: $input) { status } }`,
        managerToken,
        { input: { lines: [{ variantId, receivedQuantity: 2, serials: [serials[0], serials[2]], note: 'One lost' }] } },
      );

      expect(received.errors).toBeUndefined();
      expect(received.data!.receiveStockTransfer.status).toBe('PARTIALLY_RECEIVED');
      expect(await unit(variantId, serials[0])).toMatchObject({ status: 'IN_STOCK', locationId: branchId });
      expect(await unit(variantId, serials[2])).toMatchObject({ status: 'IN_STOCK', locationId: branchId });
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'WRITTEN_OFF', locationId: null });
      expect(await reconcile()).toEqual([]);
    });

    it('restocks a returned unit only if it was sold on that order', async () => {
      const { variantId, serials } = await stockedPhone(2);
      const { orderId, orderItemId, grandTotal } = await placeOrder(variantId, 1, PaymentMethod.ONLINE);
      await pay(orderId, Number(grandTotal));
      await ship(orderId, 'PICKING');
      await assign(orderItemId, [serials[0]]);
      await ship(orderId, 'OUT_FOR_DELIVERY');
      await ship(orderId, 'DELIVERED');
      const returnRequest = await prisma.returnRequest.create({
        data: { orderId, userId: BUYER, reason: 'Faulty screen', status: 'APPROVED' },
      });
      const restockReturn = (serial: string) => restock(variantId, [serial], 1, { returnRequestId: returnRequest.id });

      const wrong = await restockReturn(serials[1]);
      expect(codeOf(wrong)).toBe('CONFLICT');
      expect(wrong.errors![0].message).toContain('not sold on this order');

      const back = await restockReturn(serials[0]);
      expect(back.errors).toBeUndefined();
      expect(back.data!.restockVariant.reason).toBe('RETURN_RESTOCK');
      expect(await unit(variantId, serials[0])).toMatchObject({
        status: 'IN_STOCK',
        locationId: mainId,
        orderItemId: null,
        soldAt: null,
        warrantyEndsAt: null,
      });
      expect(await reconcile()).toEqual([]);
    });

    it('restocks the units of an inspected item-level return by serial, each one sold on that order (P6-R.1)', async () => {
      const { variantId, serials } = await stockedPhone(3);
      const { orderId, orderItemId, grandTotal } = await placeOrder(variantId, 2, PaymentMethod.ONLINE);
      await pay(orderId, Number(grandTotal));
      await ship(orderId, 'PICKING');
      await assign(orderItemId, [serials[0], serials[1]]);
      await ship(orderId, 'OUT_FOR_DELIVERY');
      await ship(orderId, 'DELIVERED');
      const returned = await prisma.returnRequest.create({
        data: {
          orderId,
          userId: BUYER,
          status: 'RECEIVED',
          lines: { create: { orderItemId, quantity: 2, receivedQuantity: 2, reason: 'DEFECTIVE' } },
        },
        include: { lines: true },
      });
      const inspect = (restockSerials: string[]) =>
        gql('mutation($input: InspectReturnInput!) { inspectReturn(input: $input) { status } }', managerToken, {
          input: {
            returnRequestId: returned.id,
            lines: [
              { returnLineId: returned.lines[0].id, restockQuantity: 1, writeOffQuantity: 1, serials: restockSerials },
            ],
          },
        });

      const wrong = await inspect([serials[2]]);
      expect(codeOf(wrong)).toBe('CONFLICT');
      expect(wrong.errors![0].message).toContain('not sold on this order');

      const inspected = await inspect([serials[0]]);
      expect(inspected.errors).toBeUndefined();
      expect(inspected.data!.inspectReturn.status).toBe('INSPECTED');
      expect(await unit(variantId, serials[0])).toMatchObject({
        status: 'IN_STOCK',
        locationId: mainId,
        orderItemId: null,
      });
      expect(await unit(variantId, serials[1])).toMatchObject({ status: 'SOLD' });
      expect(
        await prisma.stockMovement.findMany({
          where: { variantId, reason: 'RETURN_RESTOCK' },
          select: { onHandDelta: true, refType: true, refId: true, locationId: true },
        }),
      ).toEqual([{ onHandDelta: 1, refType: 'ReturnRequest', refId: returned.id, locationId: mainId }]);
      expect(await reconcile()).toEqual([]);
    });

    it('refuses to approve a stock-take variance on a serial-tracked variant, and approves an exact count', async () => {
      const { variantId } = await stockedPhone(2);
      const openCount = async (counted: number) => {
        const opened = await gql(`mutation { openStockTake(input: { variantIds: ["${variantId}"] }) { id } }`);
        const id = opened.data!.openStockTake.id as string;
        await gql(
          `mutation { recordStockTakeCounts(input: { stockTakeId: "${id}", counts: [{ variantId: "${variantId}", countedQuantity: ${counted} }] }) { variantId } }`,
        );
        await gql(`mutation { submitStockTake(id: "${id}") { status } }`);
        return id;
      };

      const short = await openCount(1);
      const refused = await gql(`mutation { approveStockTake(id: "${short}") { status } }`);
      expect(codeOf(refused)).toBe('CONFLICT');
      expect(reasonOf(refused)).toBe('STOCK_TAKE_SERIAL_VARIANCE');
      expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 2 });
      await gql(`mutation { cancelStockTake(id: "${short}") { status } }`);

      const exact = await openCount(2);
      const approved = await gql(`mutation { approveStockTake(id: "${exact}") { status } }`);
      expect(approved.errors).toBeUndefined();
      expect(approved.data!.approveStockTake.status).toBe('APPROVED');
    });
  });

  describe('reconciliation', () => {
    it('reports units on a shelf that the ledger does not account for', async () => {
      const variantId = await newPhone();
      const stray = await prisma.serialUnit.create({ data: { variantId, serial: imei(888_888), locationId: mainId } });

      const found = await reconcile();

      expect(found).toEqual([{ kind: 'SERIAL_UNITS', variantId, locationId: mainId, expected: 0, actual: 1 }]);
      await prisma.serialUnit.delete({ where: { id: stray.id } });
      expect(await reconcile()).toEqual([]);
    });
  });
});
