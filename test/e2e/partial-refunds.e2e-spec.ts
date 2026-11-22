import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import {
  OrderStatus,
  PaymentMethod,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  ReturnStatus,
} from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient, PaystackRequestRejected } from '../../src/payment/paystack.client';
import { EmailService } from '../../src/notifications/email/email.service';
import { JobQueue } from '../../src/jobs/job-queues';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, seedPaymentAttempt, setStock, takeOrderNumber } from '../helpers/db.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { quoteHashFor } from '../helpers/checkout.helper';
import { createCoupon } from '../helpers/promotion.helper';
import { migrationSql, migrationSqlFrom, ScratchSchema } from '../helpers/migration.helper';

interface GqlError {
  message: string;
  extensions: { code: string; reason?: string };
}
interface GqlBody {
  data?: Record<string, unknown> | null;
  errors?: GqlError[];
}
interface RefundResult {
  id: string;
  status: string;
  method: string;
  reason: string;
  amount: { amount: string };
  taxAmount: { amount: string } | null;
  shippingAmount: { amount: string };
  lines: { orderItemId: string; quantity: number; amount: { amount: string } }[];
}

async function waitUntil(condition: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(100);
  }
}

const REFUND_FIELDS = `id status method reason note createdById amount { amount } taxAmount { amount }
  shippingAmount { amount } lines { orderItemId quantity amount { amount } }`;

// Refunds of a paid order outside the returns flow (P3-C.1): by line units, free amount and shipping, capped per line,
// per payment and for shipping, idempotent per key, cash for COD, emailed to the customer by the worker.
describe('Partial refunds (e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let workerEmail: EmailService;
  let userToken: string;
  let adminToken: string;
  let orderCount = 0;
  let keyCount = 0;
  let providerRefundCount = 0;

  const paystack = {
    createRefund: jest.fn(),
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
  };
  const acceptRefunds = (delayMs = 0) =>
    paystack.createRefund.mockImplementation(async () => {
      await sleep(delayMs);
      providerRefundCount += 1;
      return { id: `rf_partial_${providerRefundCount}`, status: 'pending' };
    });

  const nextKey = () => {
    keyCount += 1;
    return `partial-key-${String(keyCount).padStart(4, '0')}`;
  };
  const codeOf = (body: GqlBody) => body.errors?.[0]?.extensions.code;

  const refundOrder = async (input: Record<string, unknown>, token = adminToken): Promise<GqlBody> =>
    (
      await gqlRequest(
        app,
        `mutation($input: RefundOrderInput!) { refundOrder(input: $input) { ${REFUND_FIELDS} } }`,
        { input: { idempotencyKey: nextKey(), reason: 'DAMAGED', ...input } },
        token,
      ).expect(200)
    ).body;
  const refunded = (body: GqlBody): RefundResult => {
    expect(body.errors).toBeUndefined();
    return body.data!.refundOrder as RefundResult;
  };
  const intentStatus = async (orderId: string) =>
    (await prisma.paymentIntent.findUniqueOrThrow({ where: { orderId } })).status;
  const refundsOf = (orderId: string) =>
    prisma.refund.findMany({
      where: { attempt: { intent: { orderId } } },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });

  /**
   * A delivered order stored at placement (pricingVersion 1): line A 3 x 115.00 (100 + 15 tax) with -20.00 of a GHS 30
   * coupon, line B 1 x 57.50 (50 + 7.50 tax) with -10.00, delivery 20.00. Charged 392.50, paid as `provider`.
   */
  const paidOrder = async (
    provider: PaymentProvider = PaymentProvider.PAYSTACK,
  ): Promise<{ orderId: string; lineA: string; lineB: string }> => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        currency: 'GHS',
        pricingVersion: 1,
        subtotal: '402.50',
        discountTotal: '30.00',
        taxTotal: '52.50',
        shippingTotal: '20.00',
        grandTotal: '392.50',
        status: OrderStatus.COMPLETED,
        paymentMethod: provider === PaymentProvider.PAYSTACK ? PaymentMethod.ONLINE : PaymentMethod.CASH_ON_DELIVERY,
        contactEmail: 'user@example.com',
        contactPhone: `+23324460${String(orderCount).padStart(4, '0')}`,
        adjustments: { create: [{ type: 'COUPON', code: 'SAVE30', amount: '-30.00' }] },
      },
    });
    const line = (
      variant: 'seed_var1' | 'seed_var2',
      quantity: number,
      unitNet: string,
      unitTax: string,
      share: string,
    ) =>
      prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: variant === 'seed_var1' ? 'seed_prod1' : 'seed_prod2',
          variantId: variant,
          productName: variant === 'seed_var1' ? 'Kente scarf' : 'Shea butter',
          quantity,
          unitListPrice: new Prisma.Decimal(unitNet).add(unitTax),
          unitDiscount: 0,
          unitNet,
          unitTax,
          lineTotal: new Prisma.Decimal(unitNet).add(unitTax).mul(quantity),
          orderAdjustmentShare: share,
          taxLines: {
            create: [
              {
                name: 'VAT',
                rate: '0.15',
                base: new Prisma.Decimal(unitNet).mul(quantity),
                amount: new Prisma.Decimal(unitTax).mul(quantity),
              },
            ],
          },
        },
      });
    const lineA = await line('seed_var1', 3, '100.00', '15.00', '-20.00');
    const lineB = await line('seed_var2', 1, '50.00', '7.50', '-10.00');
    if (provider === PaymentProvider.PAYSTACK) {
      await seedPaymentAttempt(prisma, { orderId: order.id, status: PaymentStatus.CAPTURED, amount: 392.5 });
    } else {
      const intent = await prisma.paymentIntent.create({
        data: { orderId: order.id, amount: '392.50', status: 'CAPTURED' },
      });
      await prisma.paymentAttempt.create({
        data: {
          intentId: intent.id,
          provider: PaymentProvider.CASH_ON_DELIVERY,
          channel: PaymentProvider.CASH_ON_DELIVERY,
          amount: '392.50',
          status: PaymentStatus.CAPTURED,
        },
      });
    }
    return { orderId: order.id, lineA: lineA.id, lineB: lineB.id };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    worker = await createTestWorker();
    workerEmail = worker.get(EmailService);
    await clearQueues(worker);
    await resetDb(prisma);
    await seedMinimal(prisma);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    acceptRefunds();
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  it('refunds line units at their stored price and tax, again up to the line quantity, then CONFLICT', async () => {
    const { orderId, lineA } = await paidOrder();

    const first = refunded(await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 1 }] }));
    expect(await intentStatus(orderId)).toBe('PARTIALLY_REFUNDED');
    const second = refunded(await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 2 }] }));
    const third = await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 1 }] });

    expect(first).toMatchObject({
      status: 'PROCESSED',
      method: 'PROVIDER',
      reason: 'DAMAGED',
      amount: { amount: '108.33' },
      taxAmount: { amount: '15.00' },
      shippingAmount: { amount: '0.00' },
      lines: [{ orderItemId: lineA, quantity: 1, amount: { amount: '108.33' } }],
    });
    // The last two units take what is left of the line: 345.00 - 20.00 - 108.33.
    expect(second).toMatchObject({ amount: { amount: '216.67' }, taxAmount: { amount: '30.00' } });
    expect(codeOf(third)).toBe('CONFLICT');
    expect(third.errors?.[0].message).toMatch(/has 0 of 3 units left/);
    expect(paystack.createRefund.mock.calls.map(([call]) => call.amount)).toEqual([10833, 21667]);
    expect(await intentStatus(orderId)).toBe('PARTIALLY_REFUNDED');
  });

  it('refunds a free amount and the shipping fee once, and moves the payment to REFUNDED at the full amount', async () => {
    const { orderId, lineA, lineB } = await paidOrder();

    const amount = refunded(await refundOrder({ orderId, amount: '50.00', reason: 'PRICE_ADJUSTMENT' }));
    const shipping = refunded(await refundOrder({ orderId, shipping: true, reason: 'NOT_DELIVERED' }));
    const shippingAgain = await refundOrder({ orderId, shipping: true });

    // 52.50 x 50 / 392.50 = 6.69
    expect(amount).toMatchObject({ amount: { amount: '50.00' }, taxAmount: { amount: '6.69' }, lines: [] });
    expect(shipping).toMatchObject({ amount: { amount: '20.00' }, shippingAmount: { amount: '20.00' } });
    expect(codeOf(shippingAgain)).toBe('CONFLICT');

    // 392.50 - 70.00 left; line B (47.50) fits, all of line A (325.00) no longer does.
    expect(codeOf(await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 3 }] }))).toBe('CONFLICT');
    refunded(await refundOrder({ orderId, lines: [{ orderItemId: lineB, quantity: 1 }] }));
    refunded(await refundOrder({ orderId, amount: '275.00' }));

    expect(await intentStatus(orderId)).toBe('REFUNDED');
    expect(codeOf(await refundOrder({ orderId, amount: '0.01' }))).toBe('CONFLICT');
    expect(paystack.createRefund.mock.calls.map(([call]) => call.amount)).toEqual([5000, 2000, 4750, 27500]);
  });

  it('lets only one of two concurrent refunds of the last units through, with one provider call', async () => {
    const { orderId, lineA } = await paidOrder();
    acceptRefunds(300);

    const results = await Promise.all([
      refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 2 }] }),
      refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 2 }] }),
    ]);

    expect(results.filter((result) => !result.errors)).toHaveLength(1);
    expect(codeOf(results.find((result) => result.errors)!)).toBe('CONFLICT');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(await refundsOf(orderId)).toHaveLength(1);
  });

  it('returns the same refund for a repeated idempotency key, sequentially or concurrently, refunding once', async () => {
    const { orderId, lineB } = await paidOrder();
    acceptRefunds(300);
    const input = { orderId, idempotencyKey: 'partial-replay-0001', lines: [{ orderItemId: lineB, quantity: 1 }] };

    const concurrent = await Promise.all([refundOrder(input), refundOrder(input)]);
    const later = refunded(await refundOrder(input));

    const ids = concurrent.map((result) => refunded(result).id);
    expect(new Set([...ids, later.id]).size).toBe(1);
    expect(later.status).toBe('PROCESSED');
    expect(paystack.createRefund).toHaveBeenCalledTimes(1);
    expect(await refundsOf(orderId)).toHaveLength(1);

    const other = await paidOrder();
    const reused = await refundOrder({ ...input, orderId: other.orderId, lines: [], amount: '1.00' });
    expect(codeOf(reused)).toBe('CONFLICT');
  });

  it('frees the units of a refund the provider refused, and a replay of its key returns the FAILED refund', async () => {
    const { orderId, lineA } = await paidOrder();
    paystack.createRefund.mockRejectedValueOnce(new PaystackRequestRejected('Paystack refund failed with HTTP 400'));
    const input = { orderId, idempotencyKey: 'partial-refused-0001', lines: [{ orderItemId: lineA, quantity: 3 }] };

    const refused = await refundOrder(input);
    const replay = refunded(await refundOrder(input));
    const retried = refunded(await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 3 }] }));

    expect(codeOf(refused)).toBe('BAD_REQUEST');
    expect(replay.status).toBe('FAILED');
    expect(retried).toMatchObject({ status: 'PROCESSED', amount: { amount: '325.00' } });
    expect(await intentStatus(orderId)).toBe('PARTIALLY_REFUNDED');
  });

  it('shares the payment cap with a return refund', async () => {
    const { orderId, lineB } = await paidOrder();
    const returnRequest = await prisma.returnRequest.create({
      data: {
        orderId,
        userId: 'seed_user',
        reason: 'Changed my mind',
        status: ReturnStatus.APPROVED,
        refundAmount: '350.00',
      },
    });
    const viaReturn = (
      await gqlRequest(
        app,
        `mutation { processRefund(returnRequestId: "${returnRequest.id}") { id status } }`,
        undefined,
        adminToken,
      ).expect(200)
    ).body as GqlBody;
    expect(viaReturn.errors).toBeUndefined();

    expect(codeOf(await refundOrder({ orderId, lines: [{ orderItemId: lineB, quantity: 1 }] }))).toBe('CONFLICT');
    refunded(await refundOrder({ orderId, amount: '42.50' }));

    expect(await intentStatus(orderId)).toBe('REFUNDED');
    expect((await refundsOf(orderId)).map((refund) => [refund.reason, refund.amount.toFixed(2)])).toEqual([
      ['RETURN', '350.00'],
      ['DAMAGED', '42.50'],
    ]);
  });

  it('records a cash-on-delivery refund as cash handed back, without a provider call', async () => {
    const { orderId, lineB } = await paidOrder(PaymentProvider.CASH_ON_DELIVERY);

    const refund = refunded(
      await refundOrder({ orderId, lines: [{ orderItemId: lineB, quantity: 1 }], reason: 'WRONG_ITEM' }),
    );

    expect(refund).toMatchObject({ status: 'PROCESSED', method: 'CASH', amount: { amount: '47.50' } });
    expect(paystack.createRefund).not.toHaveBeenCalled();
    expect(await intentStatus(orderId)).toBe('PARTIALLY_REFUNDED');
    expect(await prisma.outboxEvent.count({ where: { type: 'refund.succeeded.v1', aggregateId: orderId } })).toBe(1);
  });

  it('emails the customer once per refund through the outbox, with the amount, reason label and lines', async () => {
    const sends = jest.spyOn(workerEmail, 'sendRefundEmail').mockResolvedValue();
    const { orderId, lineA } = await paidOrder();

    refunded(await refundOrder({ orderId, lines: [{ orderItemId: lineA, quantity: 1 }], shipping: true }));

    const event = await prisma.outboxEvent.findFirstOrThrow({
      where: { type: 'refund.succeeded.v1', aggregateId: orderId },
    });
    const job = async () => getQueue(worker, JobQueue.NOTIFICATIONS).getJob(event.id);
    await waitUntil(async () => (await (await job())?.getState()) === 'completed');
    const forOrder = sends.mock.calls.filter(([, id]) => id === orderId);
    expect(forOrder).toEqual([
      [
        'user@example.com',
        orderId,
        {
          amount: '128.33',
          currency: 'GHS',
          reasonLabel: 'Item arrived damaged',
          lines: [{ productName: 'Kente scarf', quantity: 1 }],
          includesShipping: true,
        },
        event.id,
      ],
    ]);
  });

  it('shows the customer their refunds without the internal note or staff, as pending until processed', async () => {
    const { orderId, lineA } = await paidOrder();
    refunded(
      await refundOrder({
        orderId,
        lines: [{ orderItemId: lineA, quantity: 1 }],
        reason: 'OTHER',
        note: 'Goodwill after a complaint',
      }),
    );
    paystack.createRefund.mockRejectedValueOnce(new PaystackRequestRejected('Paystack refund failed with HTTP 400'));
    await refundOrder({ orderId, amount: '10.00' });

    const res = await gqlRequest(
      app,
      `{ order(orderId: "${orderId}") { refunds { id amount { amount } taxAmount { amount } shippingAmount { amount }
        reason reasonLabel status createdAt lines { orderItemId productName quantity amount { amount } } } } }`,
      undefined,
      userToken,
    ).expect(200);

    expect(res.body.errors).toBeUndefined();
    const refunds = res.body.data.order.refunds;
    expect(refunds).toMatchObject([
      {
        amount: { amount: '108.33' },
        reason: 'OTHER',
        reasonLabel: 'Other',
        status: 'REFUNDED',
        lines: [{ orderItemId: lineA, productName: 'Kente scarf', quantity: 1, amount: { amount: '108.33' } }],
      },
      { amount: { amount: '10.00' }, status: 'PENDING', lines: [] },
    ]);
    expect(JSON.stringify(refunds)).not.toContain('Goodwill');
    const hidden = await gqlRequest(
      app,
      `{ order(orderId: "${orderId}") { refunds { note createdById providerRef failureReason } } }`,
      undefined,
      userToken,
    );
    expect((hidden.body as GqlBody).errors?.map((error) => error.extensions.code)).toEqual(
      expect.arrayContaining(['GRAPHQL_VALIDATION_FAILED']),
    );
  });

  it('refuses customers, needs a recent step-up from staff, and validates the reason and note', async () => {
    const { orderId, lineA } = await paidOrder();
    const lines = [{ orderItemId: lineA, quantity: 1 }];

    expect(codeOf(await refundOrder({ orderId, lines }, userToken))).toBe('FORBIDDEN');
    expect(codeOf(await refundOrder({ orderId, lines, reason: 'OTHER' }))).toBe('BAD_REQUEST');
    expect(codeOf(await refundOrder({ orderId, lines, reason: 'RETURN' }))).toBe('BAD_REQUEST');
    expect(codeOf(await refundOrder({ orderId }))).toBe('BAD_REQUEST');
    expect(codeOf(await refundOrder({ orderId, idempotencyKey: 'short' }))).toBe('BAD_USER_INPUT');

    const redis = app.get<Redis>(REDIS_CLIENT);
    const keys = await redis.keys('mfa:step-up:*');
    if (keys.length > 0) await redis.del(...keys);
    const stale = await refundOrder({ orderId, lines });
    adminToken = await signInAdmin(app);

    expect(stale.errors?.[0].extensions.reason).toBe('STEP_UP_REQUIRED');
    expect(paystack.createRefund).not.toHaveBeenCalled();
    expect(await refundsOf(orderId)).toHaveLength(0);
  });

  it('refunds an order placed through checkout to exactly what it charged, from the stored coupon shares', async () => {
    await prisma.product.create({
      data: {
        id: 'partial_kente',
        name: 'Kente cloth',
        images: [],
        isActive: true,
        status: 'PUBLISHED',
        variants: { create: [{ id: 'partial_kente_var', sku: 'KENTE-PARTIAL', optionsKey: '', price: '33.33' }] },
      },
    });
    await setStock(prisma, 'partial_kente_var', 10);
    await setStock(prisma, 'seed_var2', 10);
    await createCoupon(prisma, { id: 'partial_coupon', code: 'PARTIAL10', type: 'AMOUNT_OFF', value: 10 });
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Refund St',
        city: 'Accra',
        country: 'GH',
      },
    });
    for (const [variantId, quantity] of [
      ['partial_kente_var', 3],
      ['seed_var2', 1],
    ] as const) {
      const res = await gqlRequest(
        app,
        `mutation { addToCart(input: { variantId: "${variantId}", quantity: ${quantity} }) { id } }`,
        undefined,
        userToken,
      ).expect(200);
      expect(res.body.errors).toBeUndefined();
    }
    const quote = { fulfillmentType: 'DELIVERY' as const, shippingAddressId: address.id, couponCode: 'PARTIAL10' };
    const placed = await gqlRequest(
      app,
      `mutation { createOrder(input: { quoteHash: "${await quoteHashFor(app, userToken, quote)}", fulfillmentType: DELIVERY,
        shippingAddressId: "${address.id}", contactEmail: "user@example.com", contactPhone: "+233244000000",
        couponCode: "PARTIAL10" }) { id } }`,
      undefined,
      userToken,
    ).expect(200);
    expect(placed.body.errors).toBeUndefined();
    const orderId: string = placed.body.data.createOrder.id;
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true } });
    const shares = order.items.reduce((total, item) => total.add(item.orderAdjustmentShare), new Prisma.Decimal(0));
    expect(shares.toFixed(2)).toBe('-10.00');
    await seedPaymentAttempt(prisma, {
      orderId,
      status: PaymentStatus.CAPTURED,
      amount: order.grandTotal.toNumber(),
    });

    const movementsBefore = await prisma.stockMovement.count({ where: { variantId: 'partial_kente_var' } });
    const [kente, other] = [
      order.items.find((item) => item.variantId === 'partial_kente_var')!,
      order.items.find((item) => item.variantId === 'seed_var2')!,
    ];
    const parts = [
      refunded(await refundOrder({ orderId, lines: [{ orderItemId: kente.id, quantity: 1 }] })),
      refunded(await refundOrder({ orderId, lines: [{ orderItemId: kente.id, quantity: 2 }] })),
      refunded(
        await refundOrder({
          orderId,
          lines: [{ orderItemId: other.id, quantity: 1 }],
          shipping: order.shippingTotal!.gt(0),
        }),
      ),
    ];

    const total = parts.reduce((sum, part) => sum.add(part.amount.amount), new Prisma.Decimal(0));
    expect(total.toFixed(2)).toBe(order.grandTotal.toFixed(2));
    expect(await intentStatus(orderId)).toBe('REFUNDED');
    // Money only: refunds never restock.
    expect(await prisma.stockMovement.count({ where: { variantId: 'partial_kente_var' } })).toBe(movementsBefore);
  });

  describe('migration of existing orders and refunds', () => {
    const MIGRATION = '20261201000000_partial_refunds';
    const BEFORE = '20261130000000_payment_provider_config';
    const BACKFILL = '-- Backfill (re-runnable): orders placed';
    let legacy: ScratchSchema;

    // o1 has a -10.00 cart coupon over three 100.00 lines (-3.33 each, the -0.01 remainder on the first), an item
    // promotion and a free-shipping adjustment (neither shared out); o2 has no cart adjustment.
    const LEGACY_DATA = `
INSERT INTO "User" ("id", "email", "updatedAt") VALUES ('u1', 'legacy-refunds@test.local', now());
INSERT INTO "Product" ("id", "name", "updatedAt") VALUES ('p1', 'Mug', now());
INSERT INTO "Variant" ("id", "productId", "sku", "optionsKey", "price", "updatedAt") VALUES ('v1', 'p1', 'MUG', '', 100, now());
INSERT INTO "Order" ("id", "orderNumber", "userId", "currency", "pricingVersion", "subtotal", "discountTotal", "taxTotal",
                     "shippingTotal", "grandTotal", "status", "contactEmail", "contactPhone", "updatedAt") VALUES
  ('o1', 1, 'u1', 'GHS', 1, 300, 10, 0, 0, 290, 'COMPLETED', 'legacy-refunds@test.local', '+233200000000', now()),
  ('o2', 2, 'u1', 'GHS', 1, 100, 0, 0, 0, 100, 'COMPLETED', 'legacy-refunds@test.local', '+233200000000', now());
INSERT INTO "OrderItem" ("id", "orderId", "productId", "variantId", "productName", "quantity", "unitListPrice",
                         "unitDiscount", "unitNet", "unitTax", "lineTotal") VALUES
  ('i1', 'o1', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100),
  ('i2', 'o1', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100),
  ('i3', 'o1', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100),
  ('i4', 'o2', 'p1', 'v1', 'Mug', 1, 100, 0, 100, 0, 100);
INSERT INTO "OrderAdjustment" ("id", "orderId", "orderItemId", "type", "target", "amount") VALUES
  ('a1', 'o1', NULL, 'COUPON', 'MERCHANDISE', -10),
  ('a2', 'o1', 'i2', 'DISCOUNT', 'MERCHANDISE', 0),
  ('a3', 'o1', NULL, 'DISCOUNT', 'SHIPPING', -5);
INSERT INTO "PaymentIntent" ("id", "orderId", "amount", "updatedAt") VALUES ('pi1', 'o1', 290, now());
INSERT INTO "PaymentAttempt" ("id", "intentId", "provider", "amount", "channel", "status", "updatedAt") VALUES
  ('pa1', 'pi1', 'PAYSTACK', 290, 'card', 'CAPTURED', now());
INSERT INTO "ReturnRequest" ("id", "orderId", "userId", "reason", "updatedAt") VALUES ('rr1', 'o1', 'u1', 'Broken', now());
INSERT INTO "Refund" ("id", "attemptId", "returnRequestId", "amount", "idempotencyKey", "updatedAt") VALUES
  ('r1', 'pa1', 'rr1', 10, 'return:rr1', now()),
  ('r2', 'pa1', NULL, 10, 'auto-refund:pa1', now()),
  ('r3', 'pa1', NULL, 10, 'manual:legacy', now());
`;
    const shares = () =>
      legacy.query<{ id: string; share: string }>(
        `SELECT id, "orderAdjustmentShare"::text AS share FROM "OrderItem" ORDER BY id`,
      );

    beforeAll(async () => {
      legacy = new ScratchSchema(prisma, 'legacy_partial_refunds');
      await legacy.recreate();
      await legacy.migrateTo(BEFORE);
      await legacy.exec(LEGACY_DATA);
      await legacy.exec(migrationSql(MIGRATION));
    });

    afterAll(async () => {
      await legacy.drop();
    });

    it('gives existing refunds the reason their origin implies', async () => {
      expect(await legacy.query(`SELECT id, reason::text, method::text FROM "Refund" ORDER BY id`)).toEqual([
        { id: 'r1', reason: 'RETURN', method: 'PROVIDER' },
        { id: 'r2', reason: 'PAYMENT_NOT_ACCEPTED', method: 'PROVIDER' },
        { id: 'r3', reason: 'OTHER', method: 'PROVIDER' },
      ]);
    });

    it('shares out each order cart adjustments over its lines, and gives the same result when run again', async () => {
      const expected = [
        { id: 'i1', share: '-3.34' },
        { id: 'i2', share: '-3.33' },
        { id: 'i3', share: '-3.33' },
        { id: 'i4', share: '0.00' },
      ];
      expect(await shares()).toEqual(expected);

      await legacy.exec(`UPDATE "OrderItem" SET "orderAdjustmentShare" = 0 WHERE id = 'i1'`);
      await legacy.exec(migrationSqlFrom(MIGRATION, BACKFILL));
      await legacy.exec(migrationSqlFrom(MIGRATION, BACKFILL));

      expect(await shares()).toEqual(expected);
    });

    it('keeps refund lines in the ledger: positive quantities only, never deleted', async () => {
      await expect(
        legacy.exec(`INSERT INTO "RefundLine" ("id", "refundId", "orderItemId", "quantity", "amount")
                     VALUES ('rl0', 'r3', 'i1', 0, 1)`),
      ).rejects.toThrow(/RefundLine_quantity_check/);
      await legacy.exec(`INSERT INTO "RefundLine" ("id", "refundId", "orderItemId", "quantity", "amount")
                         VALUES ('rl1', 'r3', 'i1', 1, 10)`);
      await expect(legacy.exec(`DELETE FROM "RefundLine" WHERE id = 'rl1'`)).rejects.toThrow();
    });
  });
});
