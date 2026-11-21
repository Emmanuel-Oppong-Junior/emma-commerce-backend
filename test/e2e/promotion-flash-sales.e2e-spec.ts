import { ConflictException, INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { FulfillmentType } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, stockOf } from '../helpers/db.helper';
import { signInAdmin } from '../helpers/auth.helper';
import { createPromotion } from '../helpers/promotion.helper';

const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'flash_pickup' };
const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };

// P2-B.4: a flash sale is a promotion with a time window and a cap on the units sold at its price.
describe('Flash sales: unit caps (P2-B.4, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let shopperCount = 0;

  const newShopper = async (variantId: string, quantity: number) => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `flash-${shopperCount}@example.com` } });
    const cart = await prisma.cart.create({ data: { userId: user.id } });
    const { productId } = await prisma.variant.findUniqueOrThrow({ where: { id: variantId } });
    await prisma.cartItem.create({ data: { cartId: cart.id, productId, variantId, quantity } });
    return user.id;
  };
  const place = async (userId: string) => {
    const { quoteHash } = await orders.checkoutQuote(userId, pickup);
    return orders.createOrderFromCart(userId, { ...pickup, ...contact, quoteHash });
  };
  const unitsUsed = async (id: string) => (await prisma.promotion.findUniqueOrThrow({ where: { id } })).unitsUsed;
  const lineSummary = (lines: { quantity: number; unitDiscount: { toFixed(digits: number): string } }[]) =>
    lines.map((line) => [line.quantity, line.unitDiscount.toFixed(2)]);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: { id: 'flash_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('sells the units left at the promotional price and the rest at the normal price, charging exactly the quote', async () => {
    await createPromotion(prisma, {
      id: 'phone_flash',
      type: 'AMOUNT_OFF',
      value: 100,
      targetIds: ['seed_prod2'],
      unitCap: 5,
      unitsUsed: 2,
    });
    const userId = await newShopper('seed_var2', 5);
    const stockBefore = await stockOf(prisma, 'seed_var2');

    const quote = await orders.checkoutQuote(userId, pickup);
    const order = await orders.createOrderFromCart(userId, { ...pickup, ...contact, quoteHash: quote.quoteHash });

    expect(lineSummary(quote.lines)).toEqual([
      [3, '100.00'],
      [2, '0.00'],
    ]);
    expect(new Set(quote.lines.map((line) => line.cartItemId)).size).toBe(1);
    expect(quote.grandTotal.toFixed(2)).toBe('2199.95');
    expect(order.grandTotal.toFixed(2)).toBe(quote.grandTotal.toFixed(2));
    const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { unitDiscount: 'desc' } });
    expect(items.map((item) => [item.variantId, item.quantity, item.unitDiscount.toFixed(2)])).toEqual([
      ['seed_var2', 3, '100.00'],
      ['seed_var2', 2, '0.00'],
    ]);
    const adjustments = await prisma.orderAdjustment.findMany({ where: { orderId: order.id } });
    expect(adjustments.map((a) => [a.sourceId, a.amount.toFixed(2)])).toEqual([['phone_flash', '-300.00']]);
    expect(await prisma.redemption.findMany({ where: { orderId: order.id }, select: { units: true } })).toEqual([
      { units: 3 },
    ]);
    expect(await unitsUsed('phone_flash')).toBe(5);
    expect((await stockOf(prisma, 'seed_var2')).reserved).toBe(stockBefore.reserved + 5);

    // Sold out: the next customer pays the normal price.
    const next = await newShopper('seed_var2', 1);
    expect((await orders.checkoutQuote(next, pickup)).discountTotal.toFixed(2)).toBe('0.00');
  });

  it('lets one of two customers racing for the last units have them; the other gets CONFLICT and nothing is over-reserved', async () => {
    await createPromotion(prisma, {
      id: 'laptop_flash',
      type: 'PERCENT',
      value: 50,
      targetIds: ['seed_prod1'],
      unitCap: 2,
      stackingGroup: 'flash',
    });
    const [first, second] = [await newShopper('seed_var1', 2), await newShopper('seed_var1', 2)];
    const quotes = await Promise.all([first, second].map((userId) => orders.checkoutQuote(userId, pickup)));
    expect(quotes.map((quote) => lineSummary(quote.lines))).toEqual([[[2, '500.00']], [[2, '500.00']]]);

    const results = await Promise.allSettled(
      [first, second].map((userId, index) =>
        orders.createOrderFromCart(userId, { ...pickup, ...contact, quoteHash: quotes[index].quoteHash }),
      ),
    );

    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    // A loser that priced before the winner committed is stopped by the conditional increment; one that priced after
    // sees no units left, so its quote changed.
    const { extensions } = (refused[0].reason as ConflictException).getResponse() as { extensions: { reason: string } };
    expect(['PROMOTION_UNITS_SOLD_OUT', 'QUOTE_CHANGED']).toContain(extensions.reason);
    expect(await unitsUsed('laptop_flash')).toBe(2);
    expect(await prisma.redemption.count({ where: { promotionId: 'laptop_flash' } })).toBe(1);
    const loser = results[0].status === 'rejected' ? first : second;
    expect(lineSummary((await orders.checkoutQuote(loser, pickup)).lines)).toEqual([[2, '0.00']]);
  });

  it('gives the units back when an unpaid order is cancelled or expires, once, but not when a paid order is cancelled', async () => {
    await createPromotion(prisma, {
      id: 'release_flash',
      type: 'AMOUNT_OFF',
      value: 10,
      targetIds: ['seed_var1'],
      scope: 'SKU',
      unitCap: 10,
      stackingGroup: 'release',
    });
    const [cancelling, expiring, paying] = [
      await newShopper('seed_var1', 2),
      await newShopper('seed_var1', 2),
      await newShopper('seed_var1', 2),
    ];
    const cancelled = await place(cancelling);
    const expired = await place(expiring);
    const paid = await place(paying);
    expect(await unitsUsed('release_flash')).toBe(6);

    await orders.cancelOrder(cancelling, cancelled.id);
    await prisma.order.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await orders.expireAbandonedOrders(1);
    await expect(orders.cancelOrder(cancelling, cancelled.id)).rejects.toThrow(ConflictException);
    expect(await unitsUsed('release_flash')).toBe(2);

    const intent = await prisma.paymentIntent.create({
      data: { orderId: paid.id, amount: paid.grandTotal, status: 'CAPTURED' },
    });
    await prisma.paymentAttempt.create({
      data: { intentId: intent.id, provider: 'PAYSTACK', amount: paid.grandTotal, status: 'CAPTURED', channel: 'card' },
    });
    await prisma.order.update({ where: { id: paid.id }, data: { status: 'CONFIRMED' } });
    await orders.adminCancelOrder(paid.id, undefined, 'Customer asked for a refund');

    expect(await unitsUsed('release_flash')).toBe(2);
    const redemptions = await prisma.redemption.findMany({
      where: { promotionId: 'release_flash' },
      select: { orderId: true, status: true, units: true },
    });
    expect(redemptions).toEqual(
      expect.arrayContaining([
        { orderId: cancelled.id, status: 'RELEASED', units: 2 },
        { orderId: expired.id, status: 'RELEASED', units: 2 },
        { orderId: paid.id, status: 'RESERVED', units: 2 },
      ]),
    );
  });

  describe('admin API', () => {
    let managerToken: string;
    const gql = (query: string) => gqlRequest(app, query, undefined, managerToken).expect(200);

    beforeAll(async () => {
      managerToken = await signInAdmin(app);
    });

    it('sets, shows and changes a unit cap, audited, and shows the units each redemption bought', async () => {
      const created = await gql(
        `mutation { createPromotion(input: {
          name: "Midnight flash", scope: PRODUCT, type: PERCENT, value: "30", targetIds: ["seed_prod2"], unitCap: 50,
          isActive: true, endsAt: "${new Date(Date.now() + 3_600_000).toISOString()}"
        }) { id unitCap unitsUsed } }`,
      );
      expect(created.body.errors).toBeUndefined();
      const { id } = created.body.data.createPromotion;
      expect(created.body.data.createPromotion).toEqual({ id, unitCap: 50, unitsUsed: 0 });

      const lowered = await gql(`mutation { updatePromotion(id: "${id}", input: { unitCap: 20 }) { unitCap } }`);
      const uncapped = await gql(`mutation { updatePromotion(id: "${id}", input: { unitCap: null }) { unitCap } }`);
      const redemptions = await gql('query { redemptions(promotionId: "phone_flash") { nodes { units } } }');

      expect(lowered.body.data.updatePromotion.unitCap).toBe(20);
      expect(uncapped.body.data.updatePromotion.unitCap).toBeNull();
      expect(redemptions.body.data.redemptions.nodes).toEqual([{ units: 3 }]);
      const changes = await prisma.auditLog.findMany({
        where: { entity: 'Promotion', entityId: id, action: 'UPDATE' },
        orderBy: { createdAt: 'asc' },
      });
      expect(changes.map((row) => (row.details as { changes: Record<string, unknown> }).changes.unitCap)).toEqual([
        { from: 50, to: 20 },
        { from: 20, to: null },
      ]);
    });

    it.each([
      [
        'a unit cap on a cart promotion',
        'scope: CART, type: AMOUNT_OFF, value: "5", unitCap: 3',
        'cannot have a unitCap',
      ],
      ['a unit cap below 1', 'scope: PRODUCT, type: PERCENT, value: "5", unitCap: 0', 'unitCap'],
    ])('refuses %s', async (_case, fields, message) => {
      const res = await gql(`mutation { createPromotion(input: { name: "Bad", ${fields} }) { id } }`);

      expect(['BAD_REQUEST', 'BAD_USER_INPUT']).toContain(res.body.errors[0].extensions.code);
      expect(JSON.stringify(res.body.errors[0])).toContain(message);
    });

    it('needs a recent step-up to set a unit cap', async () => {
      const redis = app.get<Redis>(REDIS_CLIENT);
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      const res = await gql(
        'mutation { createPromotion(input: { name: "x", scope: PRODUCT, type: PERCENT, value: "5", unitCap: 3 }) { id } }',
      );

      expect(res.body.errors[0].extensions.reason).toBe('STEP_UP_REQUIRED');
      managerToken = await signInAdmin(app);
    });
  });
});
