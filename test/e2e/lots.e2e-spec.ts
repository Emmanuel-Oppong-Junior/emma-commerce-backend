import { BadRequestException, INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { LotsService } from '../../src/inventory/lots/lots.service';
import { StockTransfersService } from '../../src/inventory/transfers/stock-transfers.service';
import { StockTakeService } from '../../src/inventory/stock-take/stock-take.service';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock, stockOf, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';

const BUYER = 'seed_user';
const ADMIN = 'seed_admin';
const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS);
const MOVEMENT = 'id reason onHandDelta reservedDelta lotId adjustmentReason refType refId lot { lotNumber expiresAt }';

// P4-C.1 accept criteria on real Postgres: lot + expiry captured on receipt, FEFO allocation (one movement per lot),
// expired lots unsellable (before and after the expiry job), lots carried by transfers, returns and stock-takes, the
// tracking switch rules and the expiring-stock report, with the ledger and the lot invariant reconciled.
describe('Lots with expiry (P4-C.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let lots: LotsService;
  let adminToken: string;
  let customerToken: string;
  let addressId: string;
  let defaultLocationId: string;
  let seq = 0;

  const gql = (query: string, token = adminToken) =>
    gqlRequest(app, query, undefined, token)
      .expect(200)
      .then((res) => res.body);

  const newVariant = async (trackLots: boolean): Promise<string> => {
    seq += 1;
    const id = `lot_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `lot_prod_${seq}`,
        name: `Lot item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        trackLots,
        categoryId: 'seed_cat',
        variants: { create: { id, sku: `LOT-${seq}`, price: 10, basePrice: 10, lowStockThreshold: 0 } },
      },
    });
    return id;
  };

  const restock = (variantId: string, quantity: number, extra = '') =>
    gql(
      `mutation { restockVariant(input: { variantId: "${variantId}", quantity: ${quantity} ${extra} }) { ${MOVEMENT} } }`,
    );

  const receiveLot = async (variantId: string, lotNumber: string, expiresAt: Date, quantity: number, location = '') => {
    const body = await restock(
      variantId,
      quantity,
      `lot: { lotNumber: "${lotNumber}", expiresAt: "${expiresAt.toISOString()}" } ${location && `locationId: "${location}"`}`,
    );
    expect(body.errors).toBeUndefined();
    return prisma.lot.findUniqueOrThrow({ where: { variantId_lotNumber: { variantId, lotNumber } } });
  };

  const lotOnHand = async (lotId: string, locationId = defaultLocationId) =>
    (await prisma.lotStock.findUnique({ where: { lotId_locationId: { lotId, locationId } } }))?.onHand ?? 0;

  const expire = (lotId: string) => prisma.lot.update({ where: { id: lotId }, data: { expiresAt: inDays(-1) } });

  const placeOrder = async (
    variantId: string,
    quantity: number,
    paymentMethod: PaymentMethod = PaymentMethod.ONLINE,
  ) => {
    const cart = await prisma.cart.upsert({ where: { userId: BUYER }, create: { userId: BUYER }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity },
    });
    return placeOrderFromCart(orders, BUYER, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressId,
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod,
    });
  };

  const pay = async (orderId: string, amount: number) => {
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };
    return payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
  };

  const lotMovements = (variantId: string, reason: string) =>
    prisma.stockMovement.findMany({
      where: { variantId, reason: reason as never },
      orderBy: [{ createdAt: 'asc' }, { onHandDelta: 'asc' }],
      select: { lotId: true, onHandDelta: true, reservedDelta: true, locationId: true },
    });

  const available = async (variantId: string): Promise<number> => {
    const body = await gql(`{ product(productId: "${variantId.replace('var', 'prod')}") { variants { available } } }`);
    expect(body.errors).toBeUndefined();
    return body.data.product.variants[0].available;
  };

  const reconcile = () =>
    new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
    ).reconcile();

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    lots = app.get(LotsService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    addressId = (
      await prisma.address.create({
        data: {
          userId: BUYER,
          street: '1 Lot St',
          city: 'Accra',
          recipientName: 'Buyer',
          phone: '+233244000000',
          region: 'GREATER_ACCRA',
          country: 'GH',
        },
      })
    ).id;
    defaultLocationId = (await prisma.stockLocation.findFirstOrThrow({ where: { isDefault: true } })).id;
    adminToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  afterAll(() => app.close());

  it('needs a lot number and a future expiry to receive a lot-tracked variant, and adds to an existing lot', async () => {
    const variantId = await newVariant(true);

    const noLot = await restock(variantId, 5);
    const noExpiry = await restock(variantId, 5, 'lot: { lotNumber: "L1" }');
    const past = await restock(variantId, 5, `lot: { lotNumber: "L1", expiresAt: "${inDays(-1).toISOString()}" }`);
    const expiresAt = inDays(30);
    const first = await restock(variantId, 5, `lot: { lotNumber: "L1", expiresAt: "${expiresAt.toISOString()}" }`);
    const more = await restock(variantId, 3, `lot: { lotNumber: "L1", expiresAt: "${expiresAt.toISOString()}" }`);
    const otherExpiry = await restock(
      variantId,
      1,
      `lot: { lotNumber: "L1", expiresAt: "${inDays(31).toISOString()}" }`,
    );

    expect(noLot.errors[0]).toMatchObject({
      message: `Variant "${variantId}" tracks lots: give the lot number and expiry of the units received`,
      extensions: { code: 'BAD_REQUEST' },
    });
    expect(noExpiry.errors[0].message).toBe('Lot "L1" needs its expiry date (expiresAt)');
    expect(past.errors[0].message).toMatch(/expired goods cannot be received/);
    expect(otherExpiry.errors[0]).toMatchObject({ extensions: { code: 'BAD_REQUEST' } });
    expect(first.errors).toBeUndefined();
    const lot = await prisma.lot.findUniqueOrThrow({ where: { variantId_lotNumber: { variantId, lotNumber: 'L1' } } });
    expect(first.data.restockVariant).toMatchObject({
      reason: 'RECEIPT',
      onHandDelta: 5,
      lotId: lot.id,
      lot: { lotNumber: 'L1', expiresAt: expiresAt.toISOString() },
    });
    expect(more.data.restockVariant).toMatchObject({ onHandDelta: 3, lotId: lot.id });
    expect(await prisma.lot.count({ where: { variantId } })).toBe(1);
    expect(await lotOnHand(lot.id)).toBe(8);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Variant', entityId: variantId, action: 'STOCK_ADJUSTMENT' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit).toMatchObject({ userId: ADMIN });
    expect(audit.details).toMatchObject({ kind: 'RECEIPT', onHandDelta: 5, lots: [{ lotId: lot.id, onHandDelta: 5 }] });
  });

  it('leaves untracked variants as they were: no lot needed, none accepted', async () => {
    const variantId = await newVariant(false);

    const plain = await restock(variantId, 4);
    const withLot = await restock(variantId, 1, `lot: { lotNumber: "X", expiresAt: "${inDays(9).toISOString()}" }`);

    expect(plain.data.restockVariant).toMatchObject({ reason: 'RECEIPT', onHandDelta: 4, lotId: null, lot: null });
    expect(withLot.errors[0].message).toBe(`Variant "${variantId}" does not track lots; leave the lot out`);
    expect(await prisma.lot.count({ where: { variantId } })).toBe(0);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 4 });
  });

  it('draws an online sale first expiry first across two lots, and a cancellation puts the units back in them', async () => {
    const variantId = await newVariant(true);
    const soon = await receiveLot(variantId, 'SOON', inDays(10), 2);
    const late = await receiveLot(variantId, 'LATE', inDays(40), 5);
    const order = await placeOrder(variantId, 3);

    await pay(order.id, Number(order.grandTotal));

    expect(await lotMovements(variantId, 'SALE')).toEqual(
      expect.arrayContaining([
        { lotId: soon.id, onHandDelta: -2, reservedDelta: -2, locationId: defaultLocationId },
        { lotId: late.id, onHandDelta: -1, reservedDelta: -1, locationId: defaultLocationId },
      ]),
    );
    expect(await lotMovements(variantId, 'SALE')).toHaveLength(2);
    expect([await lotOnHand(soon.id), await lotOnHand(late.id)]).toEqual([0, 4]);

    await orders.cancelOrder(BUYER, order.id);

    expect([await lotOnHand(soon.id), await lotOnHand(late.id)]).toEqual([2, 5]);
    expect(await lotMovements(variantId, 'RETURN_RESTOCK')).toHaveLength(2);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 7, reserved: 0, available: 7 });
  });

  it('draws a cash-on-delivery sale first expiry first when the order is dispatched', async () => {
    const variantId = await newVariant(true);
    const late = await receiveLot(variantId, 'C-LATE', inDays(50), 4);
    const soon = await receiveLot(variantId, 'C-SOON', inDays(5), 1);
    await verifyPhoneForCod(prisma, BUYER);
    const order = await placeOrder(variantId, 3, PaymentMethod.CASH_ON_DELIVERY);
    const move = (status: string) =>
      gql(`mutation { updateShipmentStatus(input: { orderId: "${order.id}", status: ${status} }) { status } }`);

    expect((await move('PACKED')).errors).toBeUndefined();
    expect(await lotMovements(variantId, 'SALE')).toEqual([]);
    expect((await move('OUT_FOR_DELIVERY')).errors).toBeUndefined();

    const sales = await lotMovements(variantId, 'SALE');
    expect(sales).toHaveLength(2);
    expect(sales).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lotId: soon.id, onHandDelta: -1 }),
        expect.objectContaining({ lotId: late.id, onHandDelta: -2 }),
      ]),
    );
    expect([await lotOnHand(soon.id), await lotOnHand(late.id)]).toEqual([0, 2]);
  });

  it('never sells an expired lot: availability and placement leave it out, before and after the expiry job', async () => {
    const variantId = await newVariant(true);
    const old = await receiveLot(variantId, 'OLD', inDays(10), 3);
    await receiveLot(variantId, 'NEW', inDays(40), 2);
    expect(await available(variantId)).toBe(5);

    await expire(old.id);

    expect(await available(variantId)).toBe(2);
    await expect(placeOrder(variantId, 3)).rejects.toThrow(BadRequestException);
    const order = await placeOrder(variantId, 2);
    expect(order.id).toBeDefined();
    expect(await available(variantId)).toBe(0);

    const firstRun = await lots.writeOffExpired(new Date());
    const secondRun = await lots.writeOffExpired(new Date());

    expect(firstRun?.groups).toContainEqual({
      variantId,
      locationId: defaultLocationId,
      writtenOff: 3,
      blocked: 0,
    });
    expect(secondRun?.groups.find((group) => group.variantId === variantId)).toBeUndefined();
    const expired = await prisma.stockMovement.findMany({ where: { variantId, adjustmentReason: 'EXPIRED' } });
    expect(expired).toEqual([
      expect.objectContaining({ onHandDelta: -3, refType: 'Lot', refId: old.id, lotId: old.id, reason: 'ADJUSTMENT' }),
    ]);
    expect(await lotOnHand(old.id)).toBe(0);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 2, reserved: 2, available: 0 });
    expect(await available(variantId)).toBe(0);
  });

  it('keeps expired units held for an order: the job leaves them and the sale draws them when nothing fresher is left', async () => {
    const variantId = await newVariant(true);
    const lot = await receiveLot(variantId, 'HELD', inDays(10), 2);
    const order = await placeOrder(variantId, 2);
    await expire(lot.id);

    const run = await lots.writeOffExpired(new Date());
    await pay(order.id, Number(order.grandTotal));

    expect(run?.groups).toContainEqual({ variantId, locationId: defaultLocationId, writtenOff: 0, blocked: 2 });
    expect(await lotMovements(variantId, 'SALE')).toEqual([
      expect.objectContaining({ lotId: lot.id, onHandDelta: -2 }),
    ]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 0, reserved: 0, available: 0 });
  });

  it('removes from the lot named on a negative adjustment, first expiry first without one, and adds to a lot', async () => {
    const variantId = await newVariant(true);
    const soon = await receiveLot(variantId, 'A-SOON', inDays(10), 3);
    const late = await receiveLot(variantId, 'A-LATE', inDays(60), 3);
    const adjust = (input: string) =>
      gql(`mutation { adjustVariantStock(input: { variantId: "${variantId}", ${input} }) { ${MOVEMENT} } }`);

    const named = await adjust('delta: -2, reason: DAMAGED, lot: { lotNumber: "A-LATE" }');
    const tooMany = await adjust('delta: -2, reason: DAMAGED, lot: { lotNumber: "A-LATE" }');
    const fefo = await adjust('delta: -4, reason: LOST');
    const addNoLot = await adjust('delta: 1, reason: FOUND');
    const found = await adjust('delta: 2, reason: FOUND, lot: { lotNumber: "A-SOON" }');

    expect(named.data.adjustVariantStock).toMatchObject({
      onHandDelta: -2,
      lotId: late.id,
      adjustmentReason: 'DAMAGED',
    });
    expect(tooMany.errors[0].message).toBe('Cannot remove 2 units of lot "A-LATE": only 1 at this location');
    expect(fefo.errors).toBeUndefined();
    expect(fefo.data.adjustVariantStock).toMatchObject({ onHandDelta: -3, lotId: soon.id });
    expect(addNoLot.errors[0].message).toBe(`Variant "${variantId}" tracks lots: name the lot the units are added to`);
    expect(found.data.adjustVariantStock).toMatchObject({ onHandDelta: 2, lotId: soon.id });
    expect([await lotOnHand(soon.id), await lotOnHand(late.id)]).toEqual([2, 0]);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Variant', entityId: variantId, details: { path: ['adjustmentReason'], equals: 'LOST' } },
    });
    expect(audit.details).toMatchObject({ onHandDelta: -4, lots: [{ lotId: soon.id }, { lotId: late.id }] });
  });

  it('carries the lots of a transfer to the destination, a shortfall on the lot expiring last', async () => {
    const variantId = await newVariant(true);
    const soon = await receiveLot(variantId, 'T-SOON', inDays(10), 2);
    const late = await receiveLot(variantId, 'T-LATE', inDays(60), 4);
    const old = await receiveLot(variantId, 'T-OLD', inDays(5), 1);
    await expire(old.id);
    const { storeId } = await prisma.stockLocation.findUniqueOrThrow({ where: { id: defaultLocationId } });
    const branch = await prisma.stockLocation.create({ data: { storeId, name: `Lot branch ${seq}` } });
    const transfers = app.get(StockTransfersService);

    const tooMuch = await transfers.create(
      { fromLocationId: defaultLocationId, toLocationId: branch.id, lines: [{ variantId, quantity: 7 }] },
      ADMIN,
    );
    await expect(transfers.dispatch(tooMuch.id, ADMIN)).rejects.toThrow('only 6 available at the source');
    await transfers.cancel(tooMuch.id, ADMIN);
    const transfer = await transfers.create(
      { fromLocationId: defaultLocationId, toLocationId: branch.id, lines: [{ variantId, quantity: 4 }] },
      ADMIN,
    );
    await transfers.dispatch(transfer.id, ADMIN);
    await transfers.receive(transfer.id, [{ variantId, receivedQuantity: 3, note: 'One broken' }], ADMIN);

    expect([await lotOnHand(soon.id), await lotOnHand(late.id), await lotOnHand(old.id)]).toEqual([0, 2, 1]);
    expect([await lotOnHand(soon.id, branch.id), await lotOnHand(late.id, branch.id)]).toEqual([2, 1]);
    const arrived = await prisma.stockMovement.findMany({
      where: { variantId, locationId: branch.id, reason: 'TRANSFER' },
      select: { lotId: true, onHandDelta: true },
    });
    expect(arrived).toEqual(
      expect.arrayContaining([
        { lotId: soon.id, onHandDelta: 2 },
        { lotId: late.id, onHandDelta: 1 },
      ]),
    );
  });

  it('restocks a return into the lots the order drew from, or the lot named', async () => {
    const variantId = await newVariant(true);
    const soon = await receiveLot(variantId, 'R-SOON', inDays(10), 1);
    const late = await receiveLot(variantId, 'R-LATE', inDays(60), 5);
    const order = await placeOrder(variantId, 3);
    await pay(order.id, Number(order.grandTotal));
    await prisma.order.update({ where: { id: order.id }, data: { status: 'COMPLETED' } });
    const returned = await prisma.returnRequest.create({
      data: { orderId: order.id, userId: BUYER, reason: 'Not needed' },
    });

    const byDefault = await restock(variantId, 2, `returnRequestId: "${returned.id}"`);
    const unknownLot = await restock(variantId, 1, `returnRequestId: "${returned.id}", lot: { lotNumber: "NOPE" }`);
    const named = await restock(variantId, 1, `returnRequestId: "${returned.id}", lot: { lotNumber: "R-LATE" }`);
    const beyond = await restock(variantId, 2, `returnRequestId: "${returned.id}"`);

    expect(byDefault.errors).toBeUndefined();
    expect(byDefault.data.restockVariant).toMatchObject({ reason: 'RETURN_RESTOCK', refId: returned.id });
    expect(unknownLot.errors[0].message).toBe(`Variant "${variantId}" has no lot "NOPE"`);
    expect(named.data.restockVariant).toMatchObject({ lotId: late.id, onHandDelta: 1 });
    expect(beyond.errors[0].message).toMatch(/name the lot the returned units belong to/);
    expect([await lotOnHand(soon.id), await lotOnHand(late.id)]).toEqual([1, 5]);
  });

  it('posts a stock-take of a lot-tracked variant: a shortage first expiry first, a surplus into the latest lot', async () => {
    const short = await newVariant(true);
    const shortSoon = await receiveLot(short, 'S-SOON', inDays(10), 2);
    const shortLate = await receiveLot(short, 'S-LATE', inDays(60), 3);
    const extra = await newVariant(true);
    await receiveLot(extra, 'E-SOON', inDays(10), 1);
    const extraLate = await receiveLot(extra, 'E-LATE', inDays(90), 1);
    const stockTakes = app.get(StockTakeService);

    const session = await stockTakes.open({ variantIds: [short, extra] }, ADMIN);
    await stockTakes.recordCounts(
      {
        stockTakeId: session.id,
        counts: [
          { variantId: short, countedQuantity: 2 },
          { variantId: extra, countedQuantity: 4 },
        ],
      },
      ADMIN,
    );
    await stockTakes.submit(session.id, ADMIN);
    await stockTakes.approve(session.id, ADMIN);

    expect([await lotOnHand(shortSoon.id), await lotOnHand(shortLate.id)]).toEqual([0, 2]);
    expect(await lotOnHand(extraLate.id)).toBe(3);
    expect(await stockOf(prisma, short)).toMatchObject({ onHand: 2 });
    expect(await stockOf(prisma, extra)).toMatchObject({ onHand: 4 });
    expect(
      await prisma.stockMovement.count({ where: { refType: 'StockTake', refId: session.id, variantId: short } }),
    ).toBe(2);
  });

  it('switches lot tracking only while the product holds no stock', async () => {
    const variantId = await newVariant(false);
    const productId = variantId.replace('var', 'prod');
    const update = (trackLots: boolean) =>
      gql(
        `mutation { updateProduct(productId: "${productId}", updateProductInput: { trackLots: ${trackLots} }) { trackLots } }`,
      );
    await setStock(prisma, variantId, 2);

    const blocked = await update(true);
    await setStock(prisma, variantId, 0);
    const on = await update(true);
    await receiveLot(variantId, 'F1', inDays(20), 1);
    const offBlocked = await update(false);

    expect(blocked.errors[0]).toMatchObject({ extensions: { code: 'BAD_REQUEST' } });
    expect(blocked.errors[0].message).toMatch(
      /^Lot tracking can only be turned on when the product holds no stock: 2 on hand/,
    );
    expect(on.data.updateProduct).toEqual({ trackLots: true });
    expect(offBlocked.errors[0].message).toMatch(/^Lot tracking can only be turned off/);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entity: 'Product', entityId: productId, action: 'UPDATE' },
    });
    expect(audit.details).toMatchObject({ changes: { trackLots: { from: false, to: true } } });
  });

  it('refuses opening stock for a new lot-tracked product: it is received with a lot', async () => {
    const res = await gql(`mutation {
      createProduct(createProductInput: {
        name: "Tracked opening", trackLots: true, variants: [{ sku: "LOT-OPEN-1", basePrice: "5.00", quantity: 3 }]
      }) { id }
    }`);

    expect(res.errors[0]).toMatchObject({ extensions: { code: 'BAD_REQUEST' } });
    expect(await prisma.product.count({ where: { name: 'Tracked opening' } })).toBe(0);
  });

  it('reports lots expiring soon per location with their value, to staff only', async () => {
    const variantId = await newVariant(true);
    const soon = await receiveLot(variantId, 'X-SOON', inDays(3), 2);
    await receiveLot(variantId, 'X-FAR', inDays(200), 9);
    const gone = await receiveLot(variantId, 'X-GONE', inDays(2), 1);
    await expire(gone.id);
    const query = (args: string) =>
      `{ expiringStock(${args}) { lotId lotNumber expired sku productName onHand locations { locationId onHand }
         unitPrice { amount } value { amount } } }`;

    const report = await gql(query('withinDays: 30, categoryId: "seed_cat"'));
    const outOfRange = await gql(query('withinDays: 366'));
    const asCustomer = await gql(query('withinDays: 30'), customerToken);

    expect(report.errors).toBeUndefined();
    const mine = report.data.expiringStock.filter((line: { sku: string }) => line.sku === `LOT-${seq}`);
    expect(mine).toEqual([
      expect.objectContaining({ lotId: gone.id, expired: true, onHand: 1 }),
      {
        lotId: soon.id,
        lotNumber: 'X-SOON',
        expired: false,
        sku: `LOT-${seq}`,
        productName: `Lot item ${seq}`,
        onHand: 2,
        locations: [{ locationId: defaultLocationId, onHand: 2 }],
        unitPrice: { amount: '10.00' },
        value: { amount: '20.00' },
      },
    ]);
    expect(outOfRange.errors[0].extensions.code).toBe('BAD_USER_INPUT');
    expect(asCustomer.errors[0].extensions.code).toBe('FORBIDDEN');
  });

  it('lists a variant’s lots to staff and leaves the ledger and the lot invariant reconciled', async () => {
    const variantId = await newVariant(true);
    await receiveLot(variantId, 'V2', inDays(90), 1);
    await receiveLot(variantId, 'V1', inDays(30), 2);

    const body = await gql(`{ variantLots(variantId: "${variantId}") { lotNumber expired onHand stock { onHand } } }`);
    const mismatches = await reconcile();

    expect(body.data.variantLots).toEqual([
      { lotNumber: 'V1', expired: false, onHand: 2, stock: [{ onHand: 2 }] },
      { lotNumber: 'V2', expired: false, onHand: 1, stock: [{ onHand: 1 }] },
    ]);
    expect(mismatches).toEqual([]);
  });
});
