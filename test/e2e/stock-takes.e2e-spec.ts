import { INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { PaymentRepository } from '../../src/payment/payment.repository';
import { decideVerification } from '../../src/payment/payment-verification';
import { StockReconciliationTask } from '../../src/inventory/tasks/stock-reconciliation.task';
import { SerialUnitsRepository } from '../../src/inventory/serials/serial-units.repository';
import { StockLedgerRepository } from '../../src/inventory/stock-ledger.repository';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock, stockOf } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';
import { placeOrderFromCart } from '../helpers/checkout.helper';
import { shipmentOf } from '../helpers/shipment.helper';

type GqlBody = { data?: Record<string, any>; errors?: { message: string; extensions?: Record<string, unknown> }[] };

const BUYER = 'seed_user';

// P4-B.1 accept criteria on real Postgres: a count session at a location, expected quantities hidden from counters,
// variances posted as STOCK_TAKE adjustments on approval (once), stock that moves during the count is no variance.
describe('Stock-takes (P4-B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let payments: PaymentRepository;
  let managerToken: string;
  let clerkToken: string;
  let clerkId: string;
  let addressId: string;
  let seq = 0;

  const gql = async (query: string, token = managerToken): Promise<GqlBody> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body as GqlBody;
  const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions?.code;
  const reasonOf = (body: GqlBody) => body.errors?.[0]?.extensions?.reason;

  const newVariant = async (onHand: number, price = '12.50'): Promise<string> => {
    seq += 1;
    const id = `st_var_${seq}`;
    await prisma.product.create({
      data: {
        id: `st_prod_${seq}`,
        name: `Counted item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: {
          create: { id, sku: `ST-${String(seq).padStart(3, '0')}`, price, basePrice: price, lowStockThreshold: 0 },
        },
      },
    });
    await setStock(prisma, id, onHand);
    return id;
  };

  const open = async (variantIds: string[], token = clerkToken, extra = ''): Promise<string> => {
    const body = await gql(
      `mutation { openStockTake(input: { variantIds: ${JSON.stringify(variantIds)} ${extra} }) { id status lineCount countedCount } }`,
      token,
    );
    expect(body.errors).toBeUndefined();
    expect(body.data!.openStockTake).toMatchObject({ status: 'OPEN', lineCount: variantIds.length, countedCount: 0 });
    return body.data!.openStockTake.id as string;
  };

  const count = (stockTakeId: string, counts: Record<string, number>, token = clerkToken) =>
    gql(
      `mutation { recordStockTakeCounts(input: { stockTakeId: "${stockTakeId}", counts: [${Object.entries(counts)
        .map(([variantId, n]) => `{ variantId: "${variantId}", countedQuantity: ${n} }`)
        .join(', ')}] }) { variantId countedQuantity countedById } }`,
      token,
    );
  const submit = (id: string, token = clerkToken) => gql(`mutation { submitStockTake(id: "${id}") { status } }`, token);
  const approve = (id: string, token = managerToken) =>
    gql(`mutation { approveStockTake(id: "${id}") { status approvedById } }`, token);
  const cancel = (id: string, token = managerToken) =>
    gql(`mutation { cancelStockTake(id: "${id}", reason: "Wrong shelf") { status cancelReason } }`, token);

  const stockTakeMovements = (stockTakeId: string) =>
    prisma.stockMovement.findMany({
      where: { refType: 'StockTake', refId: stockTakeId },
      select: { variantId: true, onHandDelta: true, reason: true, adjustmentReason: true },
      orderBy: { variantId: 'asc' },
    });

  /** An online order for `quantity`, paid (its reservation CONSUMED), not yet dispatched: the goods are still here. */
  const paidOrder = async (variantId: string, quantity: number): Promise<string> => {
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
      paymentMethod: PaymentMethod.ONLINE,
    });
    const amount = Number(order.grandTotal);
    const { paymentId, reference } = await seedPaymentAttempt(prisma, { orderId: order.id, status: 'PENDING', amount });
    const verified = { reference, status: 'success', amount: amount * 100, currency: 'GHS' };
    await payments.settleAttempt(paymentId, verified, {}, (state) => decideVerification(state, verified));
    return order.id;
  };

  const dispatch = async (orderId: string) => {
    const body = await gql(
      `mutation { updateShipmentStatus(input: { shipmentId: "${await shipmentOf(prisma, orderId)}", status: OUT_FOR_DELIVERY }) { status } }`,
    );
    expect(body.errors).toBeUndefined();
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    payments = app.get(PaymentRepository);
    await resetDb(prisma);
    await seedMinimal(prisma);
    managerToken = await signInAdmin(app);
    const clerk = await signUpUser(app, { email: 'clerk@example.com', password: 'Str0ng!Passw0rd', name: 'Clerk' });
    clerkToken = clerk.accessToken;
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'clerk@example.com' } });
    clerkId = user.id;
    const [store, role] = await Promise.all([
      prisma.store.findFirstOrThrow(),
      prisma.staffRole.findUniqueOrThrow({ where: { key: 'INVENTORY_CLERK' } }),
    ]);
    await prisma.storeMembership.create({ data: { userId: user.id, storeId: store.id, roleId: role.id } });
    addressId = (
      await prisma.address.create({
        data: {
          userId: BUYER,
          street: '1 Count St',
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

  it('counts, submits and approves: each non-zero variance becomes one STOCK_TAKE adjustment, audited', async () => {
    const [short, over, exact] = [await newVariant(10), await newVariant(4), await newVariant(6)];
    const id = await open([short, over, exact]);

    const counted = await count(id, { [short]: 7, [over]: 5, [exact]: 6 });
    expect(counted.errors).toBeUndefined();
    expect(counted.data!.recordStockTakeCounts).toHaveLength(3);
    expect(counted.data!.recordStockTakeCounts[0]).toMatchObject({ countedById: clerkId });
    expect((await submit(id)).data!.submitStockTake.status).toBe('SUBMITTED');

    const approved = await approve(id);

    expect(approved.errors).toBeUndefined();
    expect(approved.data!.approveStockTake).toEqual({ status: 'APPROVED', approvedById: 'seed_admin' });
    expect(await stockTakeMovements(id)).toEqual(
      [
        { variantId: short, onHandDelta: -3, reason: 'ADJUSTMENT', adjustmentReason: 'STOCK_TAKE' },
        { variantId: over, onHandDelta: 1, reason: 'ADJUSTMENT', adjustmentReason: 'STOCK_TAKE' },
      ].sort((a, b) => a.variantId.localeCompare(b.variantId)),
    );
    expect(await stockOf(prisma, short)).toMatchObject({ onHand: 7 });
    expect(await stockOf(prisma, over)).toMatchObject({ onHand: 5 });
    expect(await stockOf(prisma, exact)).toMatchObject({ onHand: 6 });
    const lines = await prisma.stockTakeLine.findMany({ where: { stockTakeId: id }, orderBy: { variantId: 'asc' } });
    expect(
      lines
        .filter((line) => line.movementId)
        .map((line) => line.variantId)
        .sort(),
    ).toEqual([short, over].sort());
    const audits = await prisma.auditLog.findMany({
      where: { entity: 'StockTake', entityId: id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    expect(audits.map((a) => [a.action, a.userId])).toEqual([
      ['CREATE', clerkId],
      ['UPDATE', clerkId],
      ['STATUS_CHANGE', clerkId],
      ['STATUS_CHANGE', 'seed_admin'],
    ]);
  });

  it('hides expected quantities and variances from counters, and approval from them', async () => {
    const variantId = await newVariant(3);
    const id = await open([variantId]);
    await count(id, { [variantId]: 2 });

    const asClerk = await gql(
      `{ stockTakeLines(stockTakeId: "${id}") { nodes { variantId sku countedQuantity expectedQuantity } } }`,
      clerkToken,
    );
    const clerkView = await gql(
      `{ stockTakeLines(stockTakeId: "${id}") { totalCount nodes { variantId sku countedQuantity } } }`,
      clerkToken,
    );
    const asManager = await gql(
      `{ stockTakeLines(stockTakeId: "${id}") { nodes { expectedAtOpen expectedQuantity variance } } }`,
      managerToken,
    );
    await submit(id);
    const clerkApproves = await approve(id, clerkToken);
    const clerkReport = await gql(`{ stockTakeVarianceReport(id: "${id}") { totals { lineCount } } }`, clerkToken);

    expect(codeOf(asClerk)).toBe('FORBIDDEN');
    expect(clerkView.data!.stockTakeLines).toEqual({
      totalCount: 1,
      nodes: [{ variantId, sku: expect.stringMatching(/^ST-/), countedQuantity: 2 }],
    });
    expect(asManager.data!.stockTakeLines.nodes).toEqual([{ expectedAtOpen: 3, expectedQuantity: 3, variance: -1 }]);
    expect(codeOf(clerkApproves)).toBe('FORBIDDEN');
    expect(codeOf(clerkReport)).toBe('FORBIDDEN');
    expect((await approve(id)).errors).toBeUndefined();
  });

  it('takes sales during the count into account: dispatched goods are gone, paid ones not yet dispatched are not', async () => {
    const variantId = await newVariant(10);
    const id = await open([variantId]);

    // Paid during the count but still on the shelf, then another order paid and dispatched during the count.
    await paidOrder(variantId, 2);
    const dispatched = await paidOrder(variantId, 3);
    await dispatch(dispatched);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 5 });

    // 7 on the shelf: the 5 on hand plus the 2 sold units waiting for dispatch. No variance.
    await count(id, { [variantId]: 7 });
    // A unit dispatched after the count is not a variance either: approval posts deltas, not the count.
    const later = await paidOrder(variantId, 1);
    await dispatch(later);
    await submit(id);
    const report = await gql(
      `{ stockTakeVarianceReport(id: "${id}") { lines { expectedAtOpen changeSinceOpen expectedQuantity countedQuantity variance } totals { netVarianceUnits } } }`,
    );
    await approve(id);

    expect(report.data!.stockTakeVarianceReport).toEqual({
      lines: [{ expectedAtOpen: 10, changeSinceOpen: -3, expectedQuantity: 7, countedQuantity: 7, variance: 0 }],
      totals: { netVarianceUnits: 0 },
    });
    expect(await stockTakeMovements(id)).toEqual([]);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 4 });
  });

  it('posts a shortage found during sales as a delta, so later sales are kept', async () => {
    const variantId = await newVariant(8);
    const id = await open([variantId]);
    await count(id, { [variantId]: 6 });
    const later = await paidOrder(variantId, 1);
    await dispatch(later);
    await submit(id);

    await approve(id);

    expect(await stockTakeMovements(id)).toEqual([
      { variantId, onHandDelta: -2, reason: 'ADJUSTMENT', adjustmentReason: 'STOCK_TAKE' },
    ]);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 5 });
  });

  it('approves once when two approvers approve at the same time', async () => {
    const variantId = await newVariant(5);
    const id = await open([variantId]);
    await count(id, { [variantId]: 3 });
    await submit(id);

    const results = await Promise.all([approve(id), approve(id)]);

    expect(results.filter((r) => !r.errors)).toHaveLength(1);
    expect(results.map(codeOf).filter(Boolean)).toEqual(['CONFLICT']);
    expect(await stockTakeMovements(id)).toHaveLength(1);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 3 });
  });

  it('cancels before approval without moving stock, and frees the location for a new count', async () => {
    const variantId = await newVariant(5);
    const id = await open([variantId]);
    await count(id, { [variantId]: 1 });

    const second = await gql(`mutation { openStockTake(input: { variantIds: ["${variantId}"] }) { id } }`);
    const clerkCancels = await cancel(id, clerkToken);
    const cancelled = await cancel(id);
    const again = await cancel(id);
    const lateCount = await count(id, { [variantId]: 2 });

    expect(codeOf(second)).toBe('CONFLICT');
    expect(reasonOf(second)).toBe('STOCK_TAKE_ALREADY_OPEN');
    expect(codeOf(clerkCancels)).toBe('FORBIDDEN');
    expect(cancelled.data!.cancelStockTake).toEqual({ status: 'CANCELLED', cancelReason: 'Wrong shelf' });
    expect(codeOf(again)).toBe('CONFLICT');
    expect(codeOf(lateCount)).toBe('CONFLICT');
    expect(await stockTakeMovements(id)).toEqual([]);
    expect(await stockOf(prisma, variantId)).toMatchObject({ onHand: 5 });
    const next = await open([variantId]);
    expect((await cancel(next)).errors).toBeUndefined();
  });

  it('refuses to approve a shortage that would eat into reserved units, and posts nothing', async () => {
    const variantId = await newVariant(4);
    const other = await newVariant(4);
    const id = await open([variantId, other]);
    await count(id, { [variantId]: 1, [other]: 2 });
    // Two units held for an unpaid order: the count says 1 is on the shelf.
    const cart = await prisma.cart.upsert({ where: { userId: BUYER }, create: { userId: BUYER }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: variantId.replace('var', 'prod'), variantId, quantity: 2 },
    });
    await placeOrderFromCart(orders, BUYER, {
      fulfillmentType: FulfillmentType.DELIVERY,
      shippingAddressId: addressId,
      contactEmail: 'buyer@example.com',
      contactPhone: '+233244000000',
      paymentMethod: PaymentMethod.ONLINE,
    });
    await submit(id);

    const refused = await approve(id);

    expect(codeOf(refused)).toBe('CONFLICT');
    expect(reasonOf(refused)).toBe('STOCK_TAKE_BELOW_RESERVED');
    expect((await gql(`{ stockTake(id: "${id}") { status } }`)).data!.stockTake.status).toBe('SUBMITTED');
    expect(await stockTakeMovements(id)).toEqual([]);
    expect(await stockOf(prisma, other)).toMatchObject({ onHand: 4 });
    expect((await cancel(id)).errors).toBeUndefined();
  });

  it('reports variances with their value at the current price', async () => {
    const variantId = await newVariant(10, '20.00');
    const id = await open([variantId], managerToken, ', note: "Shelf B"');
    await count(id, { [variantId]: 7 });

    const report = await gql(
      `{ stockTakeVarianceReport(id: "${id}") { stockTake { id status note } lines { variantId variance unitPrice { amount } varianceValue { amount currency } }
         totals { lineCount countedCount shortageUnits netVarianceValue { amount } } } }`,
    );
    const list = await gql(
      `{ stockTakes(status: OPEN) { totalCount nodes { id countedCount lineCount } } }`,
      clerkToken,
    );

    expect(report.data!.stockTakeVarianceReport).toEqual({
      stockTake: { id, status: 'OPEN', note: 'Shelf B' },
      lines: [
        {
          variantId,
          variance: -3,
          unitPrice: { amount: '20.00' },
          varianceValue: { amount: '-60.00', currency: 'GHS' },
        },
      ],
      totals: { lineCount: 1, countedCount: 1, shortageUnits: 3, netVarianceValue: { amount: '-60.00' } },
    });
    expect(list.data!.stockTakes).toEqual({ totalCount: 1, nodes: [{ id, countedCount: 1, lineCount: 1 }] });
    await cancel(id);
  });

  it('counts per location: a second location has its own session and its own stock', async () => {
    const store = await prisma.store.findFirstOrThrow();
    const branch = await prisma.stockLocation.create({ data: { storeId: store.id, name: 'Kumasi branch' } });
    const variantId = await newVariant(6);
    await prisma.$transaction(async (tx) => {
      await tx.stockLevel.create({ data: { variantId, locationId: branch.id, onHand: 2 } });
      await tx.stockMovement.create({
        data: { variantId, locationId: branch.id, onHandDelta: 2, reason: 'RECEIPT', note: 'Test fixture' },
      });
    });
    try {
      const atDefault = await open([variantId]);
      const atBranch = await open([variantId], clerkToken, `, locationId: "${branch.id}"`);
      await count(atBranch, { [variantId]: 1 });
      await submit(atBranch);
      await approve(atBranch);

      const levels = await prisma.stockLevel.findMany({
        where: { variantId },
        select: { locationId: true, onHand: true },
      });
      expect(
        Object.fromEntries(levels.map((l) => [l.locationId === branch.id ? 'branch' : 'default', l.onHand])),
      ).toEqual({
        default: 6,
        branch: 1,
      });
      expect((await prisma.stockMovement.findFirstOrThrow({ where: { refId: atBranch } })).locationId).toBe(branch.id);
      await cancel(atDefault);
    } finally {
      // Deleting the product cascades its movements (the ledger refuses direct deletes), freeing the location.
      await prisma.stockTake.deleteMany({ where: { locationId: branch.id } });
      await prisma.product.delete({ where: { id: variantId.replace('var', 'prod') } });
      await prisma.stockLocation.delete({ where: { id: branch.id } });
    }
  });

  it('leaves the stock ledger reconciled', async () => {
    const task = new StockReconciliationTask(
      app.get(StockLedgerRepository),
      app.get(LoggerService),
      app.get(AppMetrics),
      app.get(SerialUnitsRepository),
    );

    await expect(task.reconcile()).resolves.toEqual([]);
  });
});
