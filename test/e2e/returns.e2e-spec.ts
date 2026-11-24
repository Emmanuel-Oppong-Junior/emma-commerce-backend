import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, setStock, stockOf } from '../helpers/db.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { DeliveredLine, seedDeliveredOrder } from '../helpers/returns.helper';

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

interface GqlBody {
  data?: Record<string, any> | null;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
}

// P6-R.1 accept criteria on real Postgres: item-level requests within the window of their product type, the unit caps
// (also under concurrency), the machine with its history, restock at the order's location and write-off, refunds
// priced from the snapshot (online and cash), exchanges with a replacement order, customer cancel, the staff policy
// override, audit rows, and customers never seeing staff notes.
describe('Item-level returns (P6-R.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let customerToken: string;
  let adminToken: string;
  let seq = 0;
  let refundCount = 0;
  const paystack = {
    createRefund: jest.fn(async () => {
      refundCount += 1;
      return { id: `rf_ret_${refundCount}`, status: 'pending' };
    }),
  };

  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>): Promise<GqlBody> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const reasonOf = (body: GqlBody) => body.errors?.[0]?.extensions.reason;
  const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions.code;

  /** A published product with `variants` variants at `price`, of the product type given (default General). */
  const newProduct = async (price: number, variants = 1, productTypeId = 'product_type_general') => {
    seq += 1;
    const productId = `ret_prod_${seq}`;
    await prisma.product.create({
      data: {
        id: productId,
        name: `Return item ${seq}`,
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        categoryId: 'seed_cat',
        productTypeId,
        variants: {
          create: Array.from({ length: variants }, (_, index) => ({
            id: `ret_var_${seq}_${index}`,
            sku: `RET-${seq}-${index}`,
            optionsKey: `o${index}`,
            price,
            basePrice: price,
          })),
        },
      },
    });
    return { productId, variantIds: Array.from({ length: variants }, (_, index) => `ret_var_${seq}_${index}`) };
  };

  const line = (
    product: { productId: string; variantIds: string[] },
    quantity: number,
    unitPrice: number,
  ): DeliveredLine => ({
    productId: product.productId,
    variantId: product.variantIds[0],
    quantity,
    unitPrice,
  });

  const RETURN_FIELDS =
    'id status resolution rejectionReason replacementOrderId lines { id orderItemId quantity receivedQuantity }';
  const requestReturn = (orderId: string, lines: string, resolution = 'REFUND', token = customerToken) =>
    gql(
      `mutation { requestReturn(input: { orderId: "${orderId}", resolution: ${resolution}, lines: [${lines}] }) { ${RETURN_FIELDS} } }`,
      token,
    );
  const lineInput = (orderItemId: string, quantity: number, extra = '') =>
    `{ orderItemId: "${orderItemId}", quantity: ${quantity}, reason: DAMAGED ${extra} }`;
  const approve = (id: string, note = '') =>
    gql(
      `mutation { approveReturn(input: { returnRequestId: "${id}" ${note && `, staffNote: "${note}"`} }) { status staffNote } }`,
    );
  const receive = (id: string, lines: { returnLineId: string; receivedQuantity: number }[]) =>
    gql('mutation($input: ReceiveReturnInput!) { receiveReturn(input: $input) { status } }', adminToken, {
      input: { returnRequestId: id, lines },
    });
  const inspect = (id: string, lines: { returnLineId: string; restockQuantity: number; writeOffQuantity: number }[]) =>
    gql('mutation($input: InspectReturnInput!) { inspectReturn(input: $input) { status } }', adminToken, {
      input: { returnRequestId: id, lines },
    });
  const refund = (id: string, refundShipping = false) =>
    gql(
      `mutation { refundReturn(input: { returnRequestId: "${id}", refundShipping: ${refundShipping} }) { status refund { amount { amount } shippingAmount { amount } method status lines { orderItemId quantity } } } }`,
    );

  /** Requests, approves, receives everything and inspects the return of one line; returns the return id. */
  const inspectedReturn = async (
    orderId: string,
    orderItemId: string,
    quantity: number,
    restock: number,
    resolution = 'REFUND',
    extra = '',
  ): Promise<string> => {
    const requested = await requestReturn(orderId, lineInput(orderItemId, quantity, extra), resolution);
    expect(requested.errors).toBeUndefined();
    const { id, lines } = requested.data!.requestReturn;
    expect((await approve(id)).errors).toBeUndefined();
    expect((await receive(id, [{ returnLineId: lines[0].id, receivedQuantity: quantity }])).errors).toBeUndefined();
    const inspected = await inspect(id, [
      { returnLineId: lines[0].id, restockQuantity: restock, writeOffQuantity: quantity - restock },
    ]);
    expect(inspected.errors).toBeUndefined();
    return id;
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    customerToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('requesting', () => {
    it('accepts units delivered within the window and refuses those outside it', async () => {
      const product = await newProduct(50);
      const fresh = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 50)], deliveredAt: daysAgo(13) });
      const late = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 50)], deliveredAt: daysAgo(15) });

      const ok = await requestReturn(fresh.orderId, lineInput(fresh.itemIds[0], 1));
      const refused = await requestReturn(late.orderId, lineInput(late.itemIds[0], 1));

      expect(ok.errors).toBeUndefined();
      expect(ok.data!.requestReturn).toMatchObject({ status: 'REQUESTED', resolution: 'REFUND' });
      expect(codeOf(refused)).toBe('BAD_REQUEST');
      expect(reasonOf(refused)).toBe('OUTSIDE_RETURN_WINDOW');
    });

    it("follows the product type's own window and refuses a non-returnable type", async () => {
      const type = await prisma.productType.create({ data: { key: `ret_type_${seq}`, name: 'Groceries' } });
      const product = await newProduct(20, 1, type.id);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 2, 20)], deliveredAt: daysAgo(20) });
      const setPolicy = (returnable: boolean, days: number | null) =>
        gql(
          `mutation { setProductTypeReturnPolicy(id: "${type.id}", input: { returnable: ${returnable}, returnWindowDays: ${days} }) { returnable returnWindowDays } }`,
        );

      expect((await setPolicy(true, 30)).data!.setProductTypeReturnPolicy).toEqual({
        returnable: true,
        returnWindowDays: 30,
      });
      const withinTypeWindow = await requestReturn(order.orderId, lineInput(order.itemIds[0], 1));
      await setPolicy(false, null);
      const notReturnable = await requestReturn(order.orderId, lineInput(order.itemIds[0], 1));

      expect(withinTypeWindow.errors).toBeUndefined();
      expect(reasonOf(notReturnable)).toBe('NOT_RETURNABLE');
      const audit = await prisma.auditLog.findMany({ where: { entity: 'ProductType', entityId: type.id } });
      expect(audit.map((row) => row.action)).toEqual(['UPDATE', 'UPDATE']);
    });

    it('returns some units of some lines, and refuses an order of another customer', async () => {
      const a = await newProduct(30);
      const b = await newProduct(40);
      const order = await seedDeliveredOrder(prisma, { lines: [line(a, 3, 30), line(b, 1, 40)] });
      const other = await seedDeliveredOrder(prisma, { userId: 'seed_admin', lines: [line(a, 1, 30)] });

      const partial = await requestReturn(order.orderId, lineInput(order.itemIds[0], 2));
      const notMine = await requestReturn(other.orderId, lineInput(other.itemIds[0], 1));

      expect(partial.errors).toBeUndefined();
      expect(partial.data!.requestReturn.lines).toEqual([
        expect.objectContaining({ orderItemId: order.itemIds[0], quantity: 2, receivedQuantity: null }),
      ]);
      expect(codeOf(notMine)).toBe('NOT_FOUND');
    });

    it('never lets concurrent requests return more units than were delivered', async () => {
      const product = await newProduct(25);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 2, 25)] });

      const results = await Promise.all(
        [1, 2, 3].map(() => requestReturn(order.orderId, lineInput(order.itemIds[0], 1))),
      );

      expect(results.filter((result) => !result.errors)).toHaveLength(2);
      expect(results.filter((result) => reasonOf(result) === 'RETURN_QUANTITY_EXCEEDED')).toHaveLength(1);
      const { _sum } = await prisma.returnLine.aggregate({
        where: { orderItemId: order.itemIds[0] },
        _sum: { quantity: true },
      });
      expect(_sum.quantity).toBe(2);
    });

    it('lets the customer cancel before the goods arrive, which frees the units', async () => {
      const product = await newProduct(25);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 25)] });
      const { id } = (await requestReturn(order.orderId, lineInput(order.itemIds[0], 1))).data!.requestReturn;

      const cancelled = await gql(`mutation { cancelReturn(returnRequestId: "${id}") { status } }`, customerToken);
      const again = await requestReturn(order.orderId, lineInput(order.itemIds[0], 1));

      expect(cancelled.data!.cancelReturn.status).toBe('CANCELLED');
      expect(again.errors).toBeUndefined();
      const events = await prisma.returnStatusEvent.findMany({
        where: { returnRequestId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(events.map((event) => [event.from, event.to])).toEqual([
        [null, 'REQUESTED'],
        ['REQUESTED', 'CANCELLED'],
      ]);
    });
  });

  describe('staff review', () => {
    it('rejects with a reason the customer sees, and never shows them staff notes', async () => {
      const product = await newProduct(25);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 25)] });
      const { id } = (await requestReturn(order.orderId, lineInput(order.itemIds[0], 1))).data!.requestReturn;

      const rejected = await gql(
        `mutation { rejectReturn(input: { returnRequestId: "${id}", reason: "Worn item", staffNote: "Customer abused policy" }) { status staffNote rejectionReason } }`,
      );
      const mine = await gql('{ myReturns(first: 100) { nodes { id status rejectionReason } } }', customerToken);
      const peek = (
        await gqlRequest(app, '{ myReturns { nodes { staffNote } } }', undefined, customerToken).expect(400)
      ).body as GqlBody;

      expect(rejected.data!.rejectReturn).toEqual({
        status: 'REJECTED',
        staffNote: 'Customer abused policy',
        rejectionReason: 'Worn item',
      });
      expect(mine.data!.myReturns.nodes).toContainEqual({ id, status: 'REJECTED', rejectionReason: 'Worn item' });
      expect(JSON.stringify(mine)).not.toContain('abused');
      expect(codeOf(peek)).toBe('GRAPHQL_VALIDATION_FAILED');
      expect(await prisma.outboxEvent.count({ where: { type: 'return.status_changed.v1', aggregateId: id } })).toBe(1);
    });

    it('keeps staff mutations from customers and customer mutations from staff', async () => {
      const asCustomer = await gql(
        'mutation { approveReturn(input: { returnRequestId: "x" }) { status } }',
        customerToken,
      );
      const asStaff = await gql(
        'mutation { requestReturn(input: { orderId: "x", lines: [{ orderItemId: "y", quantity: 1, reason: DAMAGED }] }) { id } }',
      );
      const list = await gql(
        '{ returns(status: REJECTED, first: 5) { totalCount nodes { id status legacy events { to } } } }',
      );

      expect(codeOf(asCustomer)).toBe('FORBIDDEN');
      expect(codeOf(asStaff)).toBe('FORBIDDEN');
      expect(list.errors).toBeUndefined();
      expect(list.data!.returns.nodes.every((node: { status: string }) => node.status === 'REJECTED')).toBe(true);
    });

    it('lets staff accept a late return with a reason, as an approved and audited return', async () => {
      const product = await newProduct(60);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 60)], deliveredAt: daysAgo(40) });
      const adminId = (await prisma.user.findUniqueOrThrow({ where: { email: 'admin@example.com' } })).id;

      const accepted = await gql(
        `mutation { acceptReturnOutsidePolicy(input: { orderId: "${order.orderId}", overrideReason: "Faulty batch recall", lines: [${lineInput(order.itemIds[0], 1)}] }) { id status userId policyOverrideReason createdById } }`,
      );

      expect(accepted.errors).toBeUndefined();
      expect(accepted.data!.acceptReturnOutsidePolicy).toMatchObject({
        status: 'APPROVED',
        userId: 'seed_user',
        policyOverrideReason: 'Faulty batch recall',
        createdById: adminId,
      });
      const audit = await prisma.auditLog.findMany({
        where: { entity: 'ReturnRequest', entityId: accepted.data!.acceptReturnOutsidePolicy.id },
      });
      expect(audit).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          userId: adminId,
          details: expect.objectContaining({ policyOverrideReason: 'Faulty batch recall' }),
        }),
      ]);
    });
  });

  describe('receipt, inspection and refund', () => {
    it("restocks units at the order's location, writes off the rest, and refunds only the units received", async () => {
      const { id: storeId } = await prisma.store.findFirstOrThrow();
      const branch = await prisma.stockLocation.create({ data: { storeId, name: `Returns branch ${seq}` } });
      const product = await newProduct(100);
      const order = await seedDeliveredOrder(prisma, {
        lines: [line(product, 3, 100)],
        shippingTotal: 15,
        stockLocationId: branch.id,
      });
      const requested = await requestReturn(order.orderId, lineInput(order.itemIds[0], 3));
      const { id, lines } = requested.data!.requestReturn;
      await approve(id, 'Send it back');
      // Short receipt: 2 of the 3 units arrived.
      expect((await receive(id, [{ returnLineId: lines[0].id, receivedQuantity: 2 }])).errors).toBeUndefined();
      expect(
        (await inspect(id, [{ returnLineId: lines[0].id, restockQuantity: 1, writeOffQuantity: 1 }])).errors,
      ).toBeUndefined();

      const movements = await prisma.stockMovement.findMany({ where: { variantId: product.variantIds[0] } });
      expect(movements).toEqual([
        expect.objectContaining({
          reason: 'RETURN_RESTOCK',
          onHandDelta: 1,
          locationId: branch.id,
          refType: 'ReturnRequest',
          refId: id,
        }),
      ]);

      const refunded = await refund(id);
      expect(refunded.errors).toBeUndefined();
      expect(refunded.data!.refundReturn).toEqual({
        status: 'REFUNDED',
        refund: {
          amount: { amount: '200.00' },
          shippingAmount: { amount: '0.00' },
          method: 'PROVIDER',
          status: 'PROCESSED',
          lines: [{ orderItemId: order.itemIds[0], quantity: 2 }],
        },
      });
      expect(paystack.createRefund).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 20000 }));
      expect(codeOf(await refund(id))).toBe('CONFLICT');
      const history = await prisma.returnStatusEvent.findMany({
        where: { returnRequestId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((event) => event.to)).toEqual([
        'REQUESTED',
        'APPROVED',
        'RECEIVED',
        'INSPECTED',
        'REFUND_PENDING',
        'REFUNDED',
      ]);
      const audit = await prisma.auditLog.findMany({ where: { entity: 'ReturnRequest', entityId: id } });
      expect(audit).toHaveLength(5);
      // The unit that never came back is no longer under return.
      const again = await requestReturn(order.orderId, lineInput(order.itemIds[0], 1));
      expect(again.errors).toBeUndefined();
    });

    it('refunds the delivery fee only when staff choose it', async () => {
      const product = await newProduct(40);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 40)], shippingTotal: 10 });
      const id = await inspectedReturn(order.orderId, order.itemIds[0], 1, 0);

      const refunded = await refund(id, true);

      expect(refunded.data!.refundReturn.refund).toMatchObject({
        amount: { amount: '50.00' },
        shippingAmount: { amount: '10.00' },
      });
    });

    it('records a cash-on-delivery return refund as cash handed back', async () => {
      const product = await newProduct(70);
      const order = await seedDeliveredOrder(prisma, { lines: [line(product, 1, 70)], payment: 'CASH_ON_DELIVERY' });
      const id = await inspectedReturn(order.orderId, order.itemIds[0], 1, 1);
      const calls = paystack.createRefund.mock.calls.length;

      const refunded = await refund(id);

      expect(refunded.errors).toBeUndefined();
      expect(refunded.data!.refundReturn).toMatchObject({
        status: 'REFUNDED',
        refund: { method: 'CASH', status: 'PROCESSED', amount: { amount: '70.00' } },
      });
      expect(paystack.createRefund.mock.calls.length).toBe(calls);
    });
  });

  describe('exchange', () => {
    it('places a replacement order at no charge with its stock reserved and sold, and closes the return', async () => {
      const product = await newProduct(80, 2);
      const [ordered, wanted] = product.variantIds;
      await setStock(prisma, wanted, 3);
      const order = await seedDeliveredOrder(prisma, {
        lines: [{ productId: product.productId, variantId: ordered, quantity: 1, unitPrice: 80 }],
      });
      const id = await inspectedReturn(
        order.orderId,
        order.itemIds[0],
        1,
        1,
        'EXCHANGE',
        `, exchangeVariantId: "${wanted}"`,
      );

      const exchanged = await gql(
        `mutation { exchangeReturn(input: { returnRequestId: "${id}" }) { status replacementOrderId } }`,
      );

      expect(exchanged.errors).toBeUndefined();
      const { replacementOrderId } = exchanged.data!.exchangeReturn;
      expect(exchanged.data!.exchangeReturn.status).toBe('EXCHANGED');
      const replacement = await prisma.order.findUniqueOrThrow({
        where: { id: replacementOrderId },
        include: { items: true, stockReservations: true },
      });
      expect(replacement).toMatchObject({ status: 'CONFIRMED', userId: 'seed_user' });
      expect(replacement.grandTotal.toFixed(2)).toBe('0.00');
      expect(replacement.items).toEqual([expect.objectContaining({ variantId: wanted, quantity: 1 })]);
      expect(replacement.stockReservations).toEqual([
        expect.objectContaining({ variantId: wanted, quantity: 1, status: 'CONSUMED' }),
      ]);
      expect(await stockOf(prisma, wanted)).toEqual({ onHand: 2, reserved: 0, available: 2 });
    });

    it('refuses an exchange at another price when requested, and one out of stock when settled', async () => {
      const product = await newProduct(80, 2);
      const [ordered, wanted] = product.variantIds;
      const order = await seedDeliveredOrder(prisma, {
        lines: [{ productId: product.productId, variantId: ordered, quantity: 1, unitPrice: 80 }],
      });
      await prisma.variant.update({ where: { id: wanted }, data: { price: 90 } });
      const pricier = await requestReturn(
        order.orderId,
        lineInput(order.itemIds[0], 1, `, exchangeVariantId: "${wanted}"`),
        'EXCHANGE',
      );
      expect(reasonOf(pricier)).toBe('EXCHANGE_NOT_ALLOWED');

      await prisma.variant.update({ where: { id: wanted }, data: { price: 80 } });
      await setStock(prisma, wanted, 0);
      const id = await inspectedReturn(
        order.orderId,
        order.itemIds[0],
        1,
        1,
        'EXCHANGE',
        `, exchangeVariantId: "${wanted}"`,
      );
      const outOfStock = await gql(`mutation { exchangeReturn(input: { returnRequestId: "${id}" }) { status } }`);

      expect(reasonOf(outOfStock)).toBe('EXCHANGE_OUT_OF_STOCK');
      expect((await prisma.returnRequest.findUniqueOrThrow({ where: { id } })).status).toBe('INSPECTED');
      // Refunding instead is still possible.
      expect((await refund(id)).data!.refundReturn.status).toBe('REFUNDED');
    });
  });
});
