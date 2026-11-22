import { BadRequestException, ConflictException, INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { StockLedgerService } from '../../src/inventory/stock-ledger.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock, stockOf, verifyPhoneForCod } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';

const BUYERS = ['seed_user', 'ledger_buyer_2'];
const TWO_HOURS_AGO = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

// ROADMAP P1-N accept criteria on real Postgres: the last unit sells once, releases are exactly-once, reservations are
// consumed by online payment or COD dispatch, and the ledger adds up.
describe('Stock ledger: reservations and movements (P1-N.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let ledger: StockLedgerService;
  let adminToken: string;
  const addressOf: Record<string, string> = {};
  let variantSeq = 0;

  const newVariant = async (onHand: number, lowStockThreshold: number | null = 0): Promise<string> => {
    variantSeq += 1;
    const id = `ledger_var_${variantSeq}`;
    await prisma.product.create({
      data: {
        id: `ledger_prod_${variantSeq}`,
        name: `Ledger item ${variantSeq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: { id, sku: `LEDGER-${variantSeq}`, price: 10, basePrice: 10, lowStockThreshold } },
      },
    });
    await setStock(prisma, id, onHand);
    return id;
  };

  const placeOrder = async (
    variantId: string,
    quantity: number,
    { buyer = BUYERS[0], paymentMethod = PaymentMethod.ONLINE }: { buyer?: string; paymentMethod?: PaymentMethod } = {},
  ) => {
    const cart = await prisma.cart.upsert({ where: { userId: buyer }, create: { userId: buyer }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity },
    });
    return placeOrderFromCart(orders, buyer, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressOf[buyer],
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod,
    });
  };

  const settleSuccessfully = async (orderId: string, amount: number) => {
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };
    return payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
  };

  const reservationsOf = (orderId: string) =>
    prisma.stockReservation.findMany({ where: { orderId }, select: { status: true, quantity: true } });
  const movements = (variantId: string, reason?: string) =>
    prisma.stockMovement.findMany({
      where: { variantId, ...(reason && { reason: reason as never }) },
      orderBy: { createdAt: 'asc' },
    });

  /** The ledger invariant N.3 reconciles nightly: movements add up to the level, ACTIVE holds to reserved. */
  const expectLedgerToAddUp = async (variantId: string) => {
    const level = await stockOf(prisma, variantId);
    const sums = await prisma.stockMovement.aggregate({
      where: { variantId },
      _sum: { onHandDelta: true, reservedDelta: true },
    });
    const held = await prisma.stockReservation.aggregate({
      where: { variantId, status: 'ACTIVE' },
      _sum: { quantity: true },
    });
    expect({ onHand: sums._sum.onHandDelta ?? 0, reserved: sums._sum.reservedDelta ?? 0 }).toEqual({
      onHand: level.onHand,
      reserved: level.reserved,
    });
    expect(held._sum.quantity ?? 0).toBe(level.reserved);
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    ledger = app.get(StockLedgerService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.user.create({ data: { id: BUYERS[1], email: 'ledger-buyer-2@example.com', name: 'Second' } });
    for (const buyer of BUYERS) {
      const address = await prisma.address.create({
        data: {
          userId: buyer,
          street: '1 Ledger St',
          city: 'Accra',
          recipientName: 'Buyer',
          phone: '+233244000000',
          region: 'GREATER_ACCRA',
          country: 'GH',
        },
      });
      addressOf[buyer] = address.id;
    }
    adminToken = await signInAdmin(app);
  });

  afterAll(() => app.close());

  it('sells the last unit once when two customers check out at the same time', async () => {
    const variantId = await newVariant(1);

    const results = await Promise.allSettled(BUYERS.map((buyer) => placeOrder(variantId, 1, { buyer })));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(BadRequestException);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 1, reserved: 1, available: 0 });
    expect(await movements(variantId, 'RESERVE')).toHaveLength(1);
    expect(await prisma.stockReservation.count({ where: { variantId, status: 'ACTIVE' } })).toBe(1);
    await expectLedgerToAddUp(variantId);
  });

  it('reserves at placement: stock stays on hand but is no longer available, with an expiry for unpaid online orders', async () => {
    const variantId = await newVariant(10);

    const order = await placeOrder(variantId, 3);

    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 10, reserved: 3, available: 7 });
    const [reservation] = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    expect(reservation).toMatchObject({ status: 'ACTIVE', quantity: 3, orderItemId: order.items[0].id });
    expect(reservation.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 59 * 60 * 1000);
  });

  it('consumes the reservation when an online payment succeeds, and only once on a repeat', async () => {
    const variantId = await newVariant(10);
    const order = await placeOrder(variantId, 2);

    const settled = await settleSuccessfully(order.id, Number(order.grandTotal));
    const again = await prisma.$transaction((tx) => ledger.consumeOrder(tx, order.id));

    expect(settled.outcome.kind).toBe('paid');
    expect(again).toBe(0);
    expect(await reservationsOf(order.id)).toEqual([{ status: 'CONSUMED', quantity: 2 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 8, reserved: 0, available: 8 });
    expect((await movements(variantId, 'SALE')).map((m) => [m.onHandDelta, m.reservedDelta, m.refId])).toEqual([
      [-2, -2, order.id],
    ]);
    await expectLedgerToAddUp(variantId);
  });

  it('holds cash-on-delivery stock without expiry and consumes it once when the order is dispatched', async () => {
    const variantId = await newVariant(5);
    await verifyPhoneForCod(prisma, BUYERS[0]);
    const order = await placeOrder(variantId, 2, { paymentMethod: PaymentMethod.CASH_ON_DELIVERY });
    const [held] = await prisma.stockReservation.findMany({ where: { orderId: order.id } });
    const move = (status: string) =>
      gqlRequest(
        app,
        `mutation { updateShipmentStatus(input: { orderId: "${order.id}", status: ${status} }) { status } }`,
        undefined,
        adminToken,
      ).expect(200);

    const packed = await move('PACKED');
    expect(await reservationsOf(order.id)).toEqual([{ status: 'ACTIVE', quantity: 2 }]);
    const shipped = await move('OUT_FOR_DELIVERY');
    // A failed delivery retried goes out again without consuming the stock a second time.
    await move('FAILED_DELIVERY');
    const retried = await move('OUT_FOR_DELIVERY');

    expect(held).toMatchObject({ status: 'ACTIVE', expiresAt: null });
    expect([packed, shipped, retried].map((res) => res.body.errors)).toEqual([undefined, undefined, undefined]);
    expect(await reservationsOf(order.id)).toEqual([{ status: 'CONSUMED', quantity: 2 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 3, reserved: 0, available: 3 });
    expect(await movements(variantId, 'SALE')).toHaveLength(1);
    await expectLedgerToAddUp(variantId);
  });

  it('cancelling twice releases the hold once', async () => {
    const variantId = await newVariant(4);
    const order = await placeOrder(variantId, 3);

    await orders.cancelOrder(BUYERS[0], order.id);
    await expect(orders.cancelOrder(BUYERS[0], order.id)).rejects.toThrow(ConflictException);

    expect(await reservationsOf(order.id)).toEqual([{ status: 'RELEASED', quantity: 3 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 4, reserved: 0, available: 4 });
    expect(await movements(variantId, 'RELEASE')).toHaveLength(1);
    await expectLedgerToAddUp(variantId);
  });

  it('a cancel racing the expiry job releases the hold once', async () => {
    const variantId = await newVariant(6);
    const order = await placeOrder(variantId, 2);
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: TWO_HOURS_AGO() } });

    await Promise.allSettled([orders.cancelOrder(BUYERS[0], order.id), orders.expireAbandonedOrders(1)]);
    await orders.expireAbandonedOrders(1);

    expect(await reservationsOf(order.id)).toEqual([{ status: 'RELEASED', quantity: 2 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 6, reserved: 0, available: 6 });
    expect(await movements(variantId, 'RELEASE')).toHaveLength(1);
    await expectLedgerToAddUp(variantId);
  });

  it('releasing the same order from two transactions at once moves stock once', async () => {
    const variantId = await newVariant(6);
    const order = await placeOrder(variantId, 2);

    const released = await Promise.all([
      prisma.$transaction((tx) => ledger.releaseOrder(tx, order.id, {})),
      prisma.$transaction((tx) => ledger.releaseOrder(tx, order.id, {})),
    ]);

    expect(released.sort()).toEqual([0, 1]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 6, reserved: 0, available: 6 });
    await expectLedgerToAddUp(variantId);
  });

  it('puts paid stock back on hand once when a paid order is cancelled before dispatch', async () => {
    const variantId = await newVariant(5);
    const order = await placeOrder(variantId, 2);
    await settleSuccessfully(order.id, Number(order.grandTotal));

    await orders.cancelOrder(BUYERS[0], order.id);

    expect(await reservationsOf(order.id)).toEqual([{ status: 'RELEASED', quantity: 2 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 5, reserved: 0, available: 5 });
    expect((await movements(variantId)).map((m) => m.reason)).toEqual(['RECEIPT', 'RESERVE', 'SALE', 'RETURN_RESTOCK']);
    await expectLedgerToAddUp(variantId);
  });

  it('a payment arriving after the order expired is sent to review and consumes nothing, so nothing is oversold', async () => {
    const variantId = await newVariant(2);
    const order = await placeOrder(variantId, 2);
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: TWO_HOURS_AGO() } });
    await orders.expireAbandonedOrders(1);
    const other = await placeOrder(variantId, 2, { buyer: BUYERS[1] });

    const settled = await settleSuccessfully(order.id, Number(order.grandTotal));

    expect(settled.outcome).toMatchObject({ kind: 'review', reason: 'ORDER_NOT_PAYABLE' });
    // The late payment parks the order in PAYMENT_REVIEW until its refund is processed (P1-O.2).
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: 'PAYMENT_REVIEW',
    });
    expect(await reservationsOf(order.id)).toEqual([{ status: 'RELEASED', quantity: 2 }]);
    expect(await reservationsOf(other.id)).toEqual([{ status: 'ACTIVE', quantity: 2 }]);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 2, reserved: 2, available: 0 });
    expect(await movements(variantId, 'SALE')).toEqual([]);
    expect(await prisma.refund.count({ where: { attempt: { intent: { orderId: order.id } } } })).toBe(1);
  });

  it('refuses to adjust away units reserved for open orders', async () => {
    const variantId = await newVariant(3);
    await placeOrder(variantId, 2);

    const res = await gqlRequest(
      app,
      `mutation { adjustVariantStock(input: { variantId: "${variantId}", delta: -2, reason: "Count" }) { id } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(res.body.errors[0].message).toBe(`Cannot remove 2 units from variant "${variantId}": only 1 available`);
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 3, reserved: 2, available: 1 });
  });

  it('restocks returned goods as RETURN_RESTOCK referencing the return request', async () => {
    const variantId = await newVariant(0);
    const delivered = await prisma.order.create({
      data: {
        orderNumber: 990_001,
        userId: BUYERS[0],
        grandTotal: 10,
        currency: 'GHS',
        pricingVersion: 0,
        status: 'COMPLETED',
        contactEmail: 'buyer@example.com',
        contactPhone: '+233244000000',
      },
    });
    const returned = await prisma.returnRequest.create({
      data: { orderId: delivered.id, userId: BUYERS[0], reason: 'Too small' },
    });

    const res = await gqlRequest(
      app,
      `mutation { restockVariant(input: { variantId: "${variantId}", quantity: 1, returnRequestId: "${returned.id}" }) {
        reason onHandDelta refType refId } }`,
      undefined,
      adminToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    expect(res.body.data.restockVariant).toEqual({
      reason: 'RETURN_RESTOCK',
      onHandDelta: 1,
      refType: 'ReturnRequest',
      refId: returned.id,
    });
    expect(await stockOf(prisma, variantId)).toEqual({ onHand: 1, reserved: 0, available: 1 });
  });

  it('emits inventory.low_stock.v1 once, when available stock crosses down to the threshold', async () => {
    const variantId = await newVariant(7, 5);

    await placeOrder(variantId, 1);
    await placeOrder(variantId, 1);
    await placeOrder(variantId, 1);

    const events = await prisma.outboxEvent.findMany({
      where: { type: 'inventory.low_stock.v1', aggregateId: variantId },
    });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ variantId, available: 5 });
  });

  it('lists the ledger newest first, a page at a time, to staff with inventory.view', async () => {
    const variantId = await newVariant(5);
    await placeOrder(variantId, 1);
    const page = (after?: string) =>
      gqlRequest(
        app,
        `query($after: ID) { stockMovements(variantId: "${variantId}", first: 1, after: $after) {
          nodes { id reason } totalCount hasNextPage } }`,
        { after: after ?? null },
        adminToken,
      ).expect(200);

    const first = await page();
    const second = await page(first.body.data.stockMovements.nodes[0].id);

    expect(first.body.data.stockMovements).toMatchObject({ totalCount: 2, hasNextPage: true });
    expect(first.body.data.stockMovements.nodes[0].reason).toBe('RESERVE');
    expect(second.body.data.stockMovements).toMatchObject({ nodes: [{ reason: 'RECEIPT' }], hasNextPage: false });
  });

  it('shows available stock in the catalogue and on-hand / reserved stock only to staff', async () => {
    const variantId = await newVariant(5);
    await placeOrder(variantId, 2);
    const productId = variantId.replace('var', 'prod');

    const catalogue = await gqlRequest(
      app,
      `{ product(productId: "${productId}") { totalStock inStock variants { available } } }`,
    ).expect(200);
    const hidden = await gqlRequest(app, `{ product(productId: "${productId}") { variants { onHand } } }`).expect(200);
    const asStaff = await gqlRequest(
      app,
      `{ variant(variantId: "${variantId}") { available onHand reserved } }`,
      undefined,
      adminToken,
    ).expect(200);
    const inStock = await gqlRequest(
      app,
      `{ products(filterArgs: { inStock: true }, paginationArgs: { first: 100 }) { edges { node { id } } } }`,
    ).expect(200);

    expect(catalogue.body.data.product).toEqual({ totalStock: 3, inStock: true, variants: [{ available: 3 }] });
    expect(hidden.body.errors[0].extensions.code).toBe('FORBIDDEN');
    expect(asStaff.body.data.variant).toEqual({ available: 3, onHand: 5, reserved: 2 });
    expect(inStock.body.data.products.edges.map((e: { node: { id: string } }) => e.node.id)).toContain(productId);
  });

  it('leaves a product whose stock is all reserved out of the in-stock filter', async () => {
    const variantId = await newVariant(2);
    await placeOrder(variantId, 2);
    const productId = variantId.replace('var', 'prod');

    const res = await gqlRequest(
      app,
      `{ product(productId: "${productId}") { totalStock inStock }
         products(filterArgs: { inStock: true }, paginationArgs: { first: 100 }) { edges { node { id } } } }`,
    ).expect(200);

    expect(res.body.data.product).toEqual({ totalStock: 0, inStock: false });
    expect(res.body.data.products.edges.map((e: { node: { id: string } }) => e.node.id)).not.toContain(productId);
  });

  it('the database refuses to reserve more than is on hand', async () => {
    const variantId = await newVariant(1);

    await expect(
      prisma.$executeRaw`UPDATE "StockLevel" SET "reserved" = 2 WHERE "variantId" = ${variantId}`,
    ).rejects.toThrow(/StockLevel_reserved_within_on_hand/);
  });
});
