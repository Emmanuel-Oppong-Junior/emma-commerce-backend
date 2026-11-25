import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { LoyaltyLedger } from '../../src/loyalty/loyalty-ledger.service';
import { LoyaltyExpiryTask } from '../../src/loyalty/loyalty-expiry.task';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock } from '../helpers/db.helper';
import { seedDeliveredOrder } from '../helpers/returns.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
}

const SUMMARY =
  'balance pointsOwed nextExpiry { points expiresAt } history { totalCount nodes { type points debtChange orderId reason expiresAt } }';
const QUOTE =
  'quoteHash grandTotal { amount } discountTotal { amount } loyalty { balance redeemablePoints pointsRedeemed amount { amount } }';

describe('Loyalty points (P6-L.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ledger: LoyaltyLedger;
  let userToken: string;
  let adminToken: string;
  let addressId: string;
  let refundKey = 0;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(async (reference: string) => {
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { reference } });
      return { reference, status: 'success', amount: attempt.amount.mul(100).toNumber(), currency: 'GHS' };
    }),
    createRefund: jest.fn(async () => ({ id: `rf_loyalty_${Date.now()}_${refundKey}`, status: 'pending' })),
  };

  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>): Promise<GqlResult> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const reasonOf = (result: GqlResult) => result.errors?.[0]?.extensions.reason;
  const codeOf = (result: GqlResult) => result.errors?.[0]?.extensions.code;

  const myLoyalty = async () => {
    const res = await gql(`{ myLoyalty { ${SUMMARY} } }`, userToken);
    expect(res.errors).toBeUndefined();
    return res.data!.myLoyalty;
  };
  const adjust = (points: number, token = adminToken) =>
    gql(
      `mutation($input: AdjustLoyaltyPointsInput!) { adjustLoyaltyPoints(input: $input) { balance pointsOwed } }`,
      token,
      { input: { userId: 'seed_user', points, reason: 'Goodwill for a late delivery' } },
    );
  const fillCart = async (quantity: number) => {
    await prisma.cartItem.deleteMany({ where: { cart: { userId: 'seed_user' } } });
    const added = await gql(
      `mutation { addToCart(input: { variantId: "seed_var2", quantity: ${quantity} }) { id } }`,
      userToken,
    );
    expect(added.errors).toBeUndefined();
  };
  const quote = (redeemPoints?: number) =>
    gql(`query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) { ${QUOTE} } }`, userToken, {
      input: { fulfillmentType: 'DELIVERY', shippingAddressId: addressId, ...(redeemPoints && { redeemPoints }) },
    });
  const createOrder = (quoteHash: string, redeemPoints?: number) =>
    gql(
      `mutation($input: CreateOrderInput!) { createOrder(input: $input) {
        id grandTotal { amount } loyaltyPointsRedeemed adjustments { type sourceId amount { amount } } items { id } } }`,
      userToken,
      {
        input: {
          fulfillmentType: 'DELIVERY',
          shippingAddressId: addressId,
          contactEmail: 'user@example.com',
          contactPhone: '+233244000000',
          quoteHash,
          ...(redeemPoints && { redeemPoints }),
        },
      },
    );
  const placeOrder = async (quantity = 1, redeemPoints?: number) => {
    await fillCart(quantity);
    const quoted = await quote(redeemPoints);
    expect(quoted.errors).toBeUndefined();
    const res = await createOrder(quoted.data!.checkoutQuote.quoteHash, redeemPoints);
    expect(res.errors).toBeUndefined();
    return res.data!.createOrder as { id: string; items: { id: string }[]; grandTotal: { amount: string } };
  };
  const payOnline = async (orderId: string) => {
    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ orderId, paymentMethod: 'CARD' })
      .expect(201);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { intent: { orderId } },
      orderBy: { createdAt: 'desc' },
    });
    const res = await gql(
      `mutation { verifyPayment(verifyPaymentInput: { reference: "${attempt.reference}" }) { status } }`,
      userToken,
    );
    expect(res.errors).toBeUndefined();
  };
  const deliver = async (orderId: string) => {
    const created = await gql(`mutation { createShipment(input: { orderId: "${orderId}" }) { id } }`);
    expect(created.errors).toBeUndefined();
    const shipmentId = created.data!.createShipment.id;
    for (const status of ['OUT_FOR_DELIVERY', 'DELIVERED']) {
      const moved = await gql(
        `mutation { updateShipmentStatus(input: { shipmentId: "${shipmentId}", status: ${status} }) { id } }`,
      );
      expect(moved.errors).toBeUndefined();
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('COMPLETED');
  };
  const completedOrder = async (quantity = 1, redeemPoints?: number) => {
    const order = await placeOrder(quantity, redeemPoints);
    await payOnline(order.id);
    await deliver(order.id);
    return order;
  };
  const refund = async (orderId: string, lines: { orderItemId: string; quantity: number }[]) => {
    refundKey += 1;
    const res = await gql(`mutation($input: RefundOrderInput!) { refundOrder(input: $input) { status } }`, adminToken, {
      input: {
        orderId,
        lines,
        reason: 'DAMAGED',
        idempotencyKey: `loyalty-refund-${String(refundKey).padStart(4, '0')}`,
      },
    });
    expect(res.errors).toBeUndefined();
    expect(res.data!.refundOrder.status).toBe('PROCESSED');
  };
  const transactionsOf = (orderId: string) =>
    prisma.loyaltyTransaction.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const balanceOf = async (userId = 'seed_user') =>
    (await prisma.loyaltyAccount.findUnique({ where: { userId } }))?.balance ?? 0;
  /** Takes every point the user has, so each test starts from zero. */
  const clearPoints = async () => {
    const account = await prisma.loyaltyAccount.findUnique({ where: { userId: 'seed_user' } });
    if (account && account.balance > 0) expect((await adjust(-account.balance)).errors).toBeUndefined();
    if (account && account.debt > 0) expect((await adjust(account.debt)).errors).toBeUndefined();
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await setStock(prisma, 'seed_var2', 500);
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244000000',
        region: 'GREATER_ACCRA',
        street: '1 Loyalty St',
        city: 'Accra',
        country: 'GH',
      },
    });
    addressId = address.id;
    ledger = app.get(LoyaltyLedger);
    userToken = await signInUser(app);
    adminToken = await signInAdmin(app);
  });

  beforeEach(clearPoints);

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('earns 1 point per whole GHS of goods paid when the order completes, once, without the delivery fee', async () => {
    const order = await completedOrder(1);
    const charged = Number(order.grandTotal.amount);
    expect(charged).toBeGreaterThan(499.99);

    const earned = await transactionsOf(order.id);
    expect(earned).toEqual([expect.objectContaining({ type: 'EARN', points: 499, debtChange: 0 })]);
    await prisma.$transaction((tx) => ledger.settleOrder(tx, order.id, new Date(), true));
    expect(await transactionsOf(order.id)).toHaveLength(1);

    const summary = await myLoyalty();
    expect(summary.balance).toBe(499);
    expect(summary.nextExpiry.points).toBe(499);
    const expiresAt = new Date(summary.history.nodes[0].expiresAt);
    expect(expiresAt.getUTCFullYear()).toBe(new Date().getUTCFullYear() + 1);
    expect(summary.history.nodes[0]).toMatchObject({ type: 'EARN', points: 499, orderId: order.id });
  });

  it('earns nothing on a cancelled order', async () => {
    const order = await placeOrder(1);
    const cancelled = await gql(`mutation { cancelOrder(orderId: "${order.id}") { status } }`, userToken);
    expect(cancelled.errors).toBeUndefined();
    expect(await transactionsOf(order.id)).toEqual([]);
  });

  it('never earns for guest orders attached later or staff accounts', async () => {
    const guest = await seedDeliveredOrder(prisma, {
      userId: 'seed_user',
      lines: [{ productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1, unitPrice: 499.99 }],
    });
    await prisma.order.update({
      where: { id: guest.orderId },
      data: { guestPhone: '+233244111111', guestPhoneVerifiedAt: new Date(), contactName: 'Ama' },
    });
    const staff = await seedDeliveredOrder(prisma, {
      userId: 'seed_admin',
      lines: [{ productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1, unitPrice: 499.99 }],
    });
    for (const orderId of [guest.orderId, staff.orderId]) {
      await prisma.$transaction((tx) => ledger.settleOrder(tx, orderId, new Date(), true));
      expect(await transactionsOf(orderId)).toEqual([]);
    }
  });

  it('takes back the points of refunded units, rounded down, and all of them once fully refunded', async () => {
    const order = await completedOrder(2);
    expect(await balanceOf()).toBe(999);

    await refund(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]);
    expect(await balanceOf()).toBe(500);
    await refund(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]);
    expect(await balanceOf()).toBe(0);
    expect((await transactionsOf(order.id)).map((t) => [t.type, t.points])).toEqual([
      ['EARN', 999],
      ['REVERSE', -499],
      ['REVERSE', -500],
    ]);
  });

  it('records points already spent as owed, paid off by the next points credited', async () => {
    const order = await completedOrder(1);
    expect((await adjust(-499)).errors).toBeUndefined();

    await refund(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]);
    expect(await myLoyalty()).toMatchObject({ balance: 0, pointsOwed: 499 });

    const repaid = await adjust(600);
    expect(repaid.data!.adjustLoyaltyPoints).toEqual({ balance: 101, pointsOwed: 0 });
  });

  it('redeems points at checkout: quoted, charged in the order transaction, shown as a LOYALTY_POINTS adjustment', async () => {
    expect((await adjust(2_000)).errors).toBeUndefined();
    await fillCart(1);
    const plain = (await quote()).data!.checkoutQuote;
    expect(plain.loyalty).toEqual({
      balance: 2_000,
      redeemablePoints: 2_000,
      pointsRedeemed: 0,
      amount: { amount: '0.00' },
    });

    const below = await quote(499);
    expect(reasonOf(below)).toBe('POINTS_BELOW_MINIMUM');
    expect(reasonOf(await quote(2_001))).toBe('INSUFFICIENT_POINTS');

    const withPoints = (await quote(1_500)).data!.checkoutQuote;
    expect(withPoints.loyalty).toMatchObject({ pointsRedeemed: 1_500, amount: { amount: '15.00' } });
    expect(Number(plain.grandTotal.amount) - Number(withPoints.grandTotal.amount)).toBeCloseTo(15, 2);
    expect(withPoints.quoteHash).not.toBe(plain.quoteHash);

    const created = await createOrder(withPoints.quoteHash, 1_500);
    expect(created.errors).toBeUndefined();
    const order = created.data!.createOrder;
    expect(order.loyaltyPointsRedeemed).toBe(1_500);
    expect(order.adjustments).toContainEqual({ type: 'LOYALTY_POINTS', sourceId: null, amount: { amount: '-15.00' } });
    expect(await balanceOf()).toBe(500);
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id } });
    expect(items.reduce((sum, item) => sum + Number(item.orderAdjustmentShare), 0)).toBeCloseTo(-15, 2);

    // Paid with points: the earn counts what the customer paid for the goods (499.99 - 15.00).
    await payOnline(order.id);
    await deliver(order.id);
    expect((await transactionsOf(order.id)).map((t) => [t.type, t.points])).toEqual([
      ['REDEEM', -1_500],
      ['EARN', 484],
    ]);
  });

  it('refuses createOrder with LOYALTY_BALANCE_CHANGED when the points fell after the quote, and never overspends', async () => {
    expect((await adjust(1_000)).errors).toBeUndefined();
    await fillCart(1);
    const quoted = (await quote(1_000)).data!.checkoutQuote;
    expect((await adjust(-600)).errors).toBeUndefined();
    const refused = await createOrder(quoted.quoteHash, 1_000);
    expect(codeOf(refused)).toBe('CONFLICT');
    expect(reasonOf(refused)).toBe('LOYALTY_BALANCE_CHANGED');

    expect((await adjust(600)).errors).toBeUndefined();
    const again = (await quote(1_000)).data!.checkoutQuote;
    const [order, taken] = await Promise.all([createOrder(again.quoteHash, 1_000), adjust(-1_000)]);
    expect([order, taken].filter((res) => !res.errors)).toHaveLength(1);
    expect(await balanceOf()).toBe(0);
    const account = await prisma.loyaltyAccount.findUniqueOrThrow({ where: { userId: 'seed_user' } });
    const lots = await prisma.loyaltyLot.aggregate({ where: { userId: 'seed_user' }, _sum: { remaining: true } });
    expect(lots._sum.remaining ?? 0).toBe(account.balance);
  });

  it('gives redeemed points back once when an unpaid order is cancelled, into the lots they came from', async () => {
    expect((await adjust(800)).errors).toBeUndefined();
    const order = await placeOrder(1, 800);
    expect(await balanceOf()).toBe(0);

    const cancelled = await gql(`mutation { cancelOrder(orderId: "${order.id}") { status } }`, userToken);
    expect(cancelled.errors).toBeUndefined();
    expect(await balanceOf()).toBe(800);
    expect((await transactionsOf(order.id)).map((t) => [t.type, t.points])).toEqual([
      ['REDEEM', -800],
      ['REDEEM_RETURN', 800],
    ]);
    await prisma.$transaction((tx) => ledger.settleOrder(tx, order.id, new Date()));
    expect(await transactionsOf(order.id)).toHaveLength(2);
  });

  it('gives back redeemed points in proportion to a refund of a paid order', async () => {
    expect((await adjust(1_000)).errors).toBeUndefined();
    const order = await completedOrder(2, 1_000);
    await refund(order.id, [{ orderItemId: order.items[0].id, quantity: 1 }]);
    const given = (await transactionsOf(order.id)).filter((t) => t.type === 'REDEEM_RETURN');
    expect(given.map((t) => t.points)).toEqual([500]);
  });

  it('expires unspent points past their expiry with the daily job', async () => {
    const past = new Date();
    past.setUTCMonth(past.getUTCMonth() - 13);
    await prisma.$transaction(async (tx) => {
      await ledger.credit(tx, 'seed_user', past, {
        type: 'ADJUST',
        points: 300,
        reason: 'Old points',
        actorId: 'seed_admin',
      });
      await ledger.credit(tx, 'seed_user', new Date(), {
        type: 'ADJUST',
        points: 200,
        reason: 'New',
        actorId: 'seed_admin',
      });
    });
    expect(await balanceOf()).toBe(500);
    expect((await myLoyalty()).balance).toBe(200);

    expect(await app.get(LoyaltyExpiryTask).expire()).toBe(1);
    expect(await balanceOf()).toBe(200);
    const expired = await prisma.loyaltyTransaction.findMany({ where: { userId: 'seed_user', type: 'EXPIRE' } });
    expect(expired.map((t) => t.points)).toContain(-300);
    expect(await app.get(LoyaltyExpiryTask).expire()).toBe(0);
  });

  it('lets only loyalty.manage staff with a recent step-up adjust points, audited; the ledger is append-only', async () => {
    expect(codeOf(await adjust(100, userToken))).toBe('FORBIDDEN');
    expect(codeOf(await adjust(-1))).toBe('CONFLICT');
    const staffAccount = await gql(
      `mutation { adjustLoyaltyPoints(input: { userId: "seed_admin", points: 10, reason: "Not for staff" }) { balance } }`,
    );
    expect(codeOf(staffAccount)).toBe('BAD_REQUEST');

    expect((await adjust(100)).errors).toBeUndefined();
    const audit = await prisma.auditLog.findFirst({
      where: { entity: 'LoyaltyAccount', entityId: 'seed_user' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toMatchObject({ action: 'UPDATE', details: { points: 100, reason: 'Goodwill for a late delivery' } });
    const staffView = await gql(`{ customerLoyalty(userId: "seed_user") { balance } }`);
    expect(staffView.data!.customerLoyalty.balance).toBe(100);

    const redis = app.get<Redis>(REDIS_CLIENT);
    const keys = await redis.keys('mfa:step-up:*');
    if (keys.length > 0) await redis.del(...keys);
    const stale = await adjust(100);
    adminToken = await signInAdmin(app);
    expect(reasonOf(stale)).toBe('STEP_UP_REQUIRED');

    await expect(prisma.$executeRaw`UPDATE "LoyaltyTransaction" SET "points" = 1`).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRaw`DELETE FROM "LoyaltyTransaction"`).rejects.toThrow(/append-only/);
  });

  it('applies the store settings: off stops earning and redeeming', async () => {
    const off = await gql(
      `mutation { updateLoyaltySettings(input: { enabled: false }) { enabled minimumRedeemPoints } }`,
    );
    expect(off.data!.updateLoyaltySettings).toEqual({ enabled: false, minimumRedeemPoints: 500 });
    expect((await gql(`{ loyaltySettings { enabled earnPointsPerCedi } }`, '')).data!.loyaltySettings).toEqual({
      enabled: false,
      earnPointsPerCedi: 1,
    });
    expect((await adjust(1_000)).errors).toBeUndefined();
    await fillCart(1);
    expect(reasonOf(await quote(1_000))).toBe('LOYALTY_DISABLED');
    const order = await completedOrder(1);
    expect(await transactionsOf(order.id)).toEqual([]);
    expect(
      (await gql(`mutation { updateLoyaltySettings(input: { enabled: true }) { enabled } }`)).errors,
    ).toBeUndefined();
  });
});
