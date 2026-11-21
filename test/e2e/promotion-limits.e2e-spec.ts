import { ConflictException, INestApplication } from '@nestjs/common';
import { FulfillmentType, PaymentMethod } from '../../src/generated/prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { OrdersService } from '../../src/order/order.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal, stockOf } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signUpUser } from '../helpers/auth.helper';
import { createCoupon, createPromotion } from '../helpers/promotion.helper';

const pickup = { fulfillmentType: FulfillmentType.PICKUP, pickupLocationId: 'limits_pickup' };
const contact = { contactEmail: 'shopper@example.com', contactPhone: '+233244000000' };
const PASSWORD = 'Passw0rd!x';

// P2-B.3: usage limits taken in the order transaction, released only before payment, first-order and group promotions.
describe('Promotion limits, first order and customer groups (P2-B.3, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let orders: OrdersService;
  let shopperCount = 0;

  /** A fresh customer with one phone (seed_var2) in the cart. */
  const newShopper = async () => {
    shopperCount += 1;
    const user = await prisma.user.create({ data: { email: `limits-${shopperCount}@example.com` } });
    await fillCart(user.id);
    return user.id;
  };
  const fillCart = async (userId: string) => {
    const cart = await prisma.cart.upsert({ where: { userId }, create: { userId }, update: {} });
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });
    await prisma.cartItem.create({
      data: { cartId: cart.id, productId: 'seed_prod2', variantId: 'seed_var2', quantity: 1 },
    });
  };
  const applied = (quote: Awaited<ReturnType<OrdersService['checkoutQuote']>>) =>
    [...quote.lines.flatMap((line) => line.adjustments), ...quote.adjustments].map((a) => a.sourceId);
  const place = async (userId: string, extra: Record<string, unknown> = {}) => {
    const params = { ...pickup, ...contact, ...extra };
    const { quoteHash } = await orders.checkoutQuote(userId, params);
    return orders.createOrderFromCart(userId, { ...params, quoteHash });
  };
  const usage = async (promotionId: string) => ({
    usedCount: (await prisma.promotion.findUniqueOrThrow({ where: { id: promotionId } })).usedCount,
    reserved: await prisma.redemption.count({ where: { promotionId, status: 'RESERVED' } }),
    released: await prisma.redemption.count({ where: { promotionId, status: 'RELEASED' } }),
  });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    orders = app.get(OrdersService);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.pickupLocation.create({
      data: { id: 'limits_pickup', name: 'Osu', address: '1 Oxford St', city: 'Accra', state: 'GA', country: 'Ghana' },
    });
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('lets exactly one of two customers racing for the last use win; the other gets CONFLICT and nothing is recorded', async () => {
    await createPromotion(prisma, {
      id: 'last_one',
      type: 'AMOUNT_OFF',
      value: 50,
      targetIds: ['seed_prod2'],
      usageLimit: 1,
    });
    const [first, second] = [await newShopper(), await newShopper()];
    const quotes = await Promise.all([first, second].map((userId) => orders.checkoutQuote(userId, pickup)));
    expect(quotes.map(applied)).toEqual([['last_one'], ['last_one']]);
    const stockBefore = await stockOf(prisma, 'seed_var2');

    const results = await Promise.allSettled(
      [first, second].map((userId, index) =>
        orders.createOrderFromCart(userId, { ...pickup, ...contact, quoteHash: quotes[index].quoteHash }),
      ),
    );

    const placed = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(placed).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    // Which CONFLICT depends on timing: a loser that priced before the winner committed is stopped by the conditional
    // increment (PROMOTION_LIMIT_REACHED); one that priced after sees no use left, so its quote changed.
    const { extensions } = (refused[0].reason as ConflictException).getResponse() as { extensions: { reason: string } };
    expect(['PROMOTION_LIMIT_REACHED', 'QUOTE_CHANGED']).toContain(extensions.reason);
    expect(await usage('last_one')).toEqual({ usedCount: 1, reserved: 1, released: 0 });
    expect(await prisma.order.count({ where: { userId: { in: [first, second] } } })).toBe(1);
    expect((await stockOf(prisma, 'seed_var2')).reserved).toBe(stockBefore.reserved + 1);
    const loser = results[0].status === 'rejected' ? first : second;
    expect(await prisma.cartItem.count({ where: { cart: { userId: loser } } })).toBe(1);
    // The loser's next quote no longer has the promotion.
    expect(applied(await orders.checkoutQuote(loser, pickup))).toEqual([]);
  });

  it("enforces the per-customer limit from the customer's reserved redemptions", async () => {
    await createPromotion(prisma, {
      id: 'twice_each',
      type: 'AMOUNT_OFF',
      value: 5,
      targetIds: ['seed_prod2'],
      perCustomerLimit: 2,
    });
    const userId = await newShopper();

    await place(userId);
    await fillCart(userId);
    await place(userId);
    await fillCart(userId);

    expect(applied(await orders.checkoutQuote(userId, pickup))).not.toContain('twice_each');
    expect(await prisma.redemption.count({ where: { promotionId: 'twice_each', customerId: userId } })).toBe(2);
  });

  it('gives the uses back when an unpaid order is cancelled or expires, once, but not when a paid order is cancelled', async () => {
    const { promotion } = await createCoupon(prisma, {
      id: 'release_me',
      code: 'RELEASE10',
      type: 'AMOUNT_OFF',
      value: 10,
      perCustomerLimit: null,
    });
    const [cancelling, expiring, paying] = [await newShopper(), await newShopper(), await newShopper()];

    const cancelled = await place(cancelling, { couponCode: 'release10' });
    const expired = await place(expiring, { couponCode: 'release10' });
    const paid = await place(paying, { couponCode: 'release10' });
    expect(await usage(promotion.id)).toEqual({ usedCount: 3, reserved: 3, released: 0 });
    expect((await prisma.couponCode.findUniqueOrThrow({ where: { code: 'RELEASE10' } })).usedCount).toBe(3);

    await orders.cancelOrder(cancelling, cancelled.id);
    await prisma.order.update({ where: { id: expired.id }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    await orders.expireAbandonedOrders(1);
    await expect(orders.cancelOrder(cancelling, cancelled.id)).rejects.toThrow(ConflictException);
    expect(await usage(promotion.id)).toEqual({ usedCount: 1, reserved: 1, released: 2 });

    // Paid online: the cancel leads to a refund, which does not give the use back.
    const intent = await prisma.paymentIntent.create({
      data: { orderId: paid.id, amount: paid.grandTotal, status: 'CAPTURED' },
    });
    await prisma.paymentAttempt.create({
      data: { intentId: intent.id, provider: 'PAYSTACK', amount: paid.grandTotal, status: 'CAPTURED', channel: 'card' },
    });
    await prisma.order.update({ where: { id: paid.id }, data: { status: 'CONFIRMED' } });
    await orders.adminCancelOrder(paid.id, undefined, 'Customer asked for a refund');

    expect((await prisma.order.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe('CANCELLED');
    expect(await usage(promotion.id)).toEqual({ usedCount: 1, reserved: 1, released: 2 });
    expect((await prisma.couponCode.findUniqueOrThrow({ where: { code: 'RELEASE10' } })).usedCount).toBe(1);
  });

  it("gives a first-order promotion only until the customer's first order is confirmed", async () => {
    await createPromotion(prisma, {
      id: 'welcome',
      type: 'PERCENT',
      value: 10,
      targetIds: ['seed_prod2'],
      firstOrderOnly: true,
      stackingGroup: 'welcome',
    });
    const userId = await newShopper();

    expect(applied(await orders.checkoutQuote(userId, pickup))).toContain('welcome');
    // An online order cancelled before payment does not count.
    const abandoned = await place(userId);
    await orders.cancelOrder(userId, abandoned.id);
    await fillCart(userId);
    expect(applied(await orders.checkoutQuote(userId, pickup))).toContain('welcome');
    // A cash-on-delivery order is confirmed when placed: it counts, even if cancelled later.
    const confirmed = await place(userId, { paymentMethod: PaymentMethod.CASH_ON_DELIVERY });
    expect(confirmed.status).toBe('CONFIRMED');
    await orders.cancelOrder(userId, confirmed.id);
    await fillCart(userId);

    expect(applied(await orders.checkoutQuote(userId, pickup))).not.toContain('welcome');
  });

  describe('customer groups', () => {
    let managerToken: string;
    let supportToken: string;
    let groupId: string;
    const gql = (query: string, token: string) => gqlRequest(app, query, undefined, token).expect(200);

    beforeAll(async () => {
      managerToken = await signInAdmin(app);
      const ownerToken = await signInSuperAdmin(app);
      await signUpUser(app, { email: 'groups-support@example.com', password: PASSWORD, name: 'Support' });
      const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'groups-support@example.com' } });
      await gql(`mutation { assignStaffRole(userId: "${id}", roleKey: "SUPPORT") { role { key } } }`, ownerToken);
      const signedIn = await gqlRequest(
        app,
        'mutation S($input: SignInInput!) { signIn(input: $input) { accessToken } }',
        { input: { email: 'groups-support@example.com', password: PASSWORD } },
      ).expect(200);
      supportToken = signedIn.body.data.signIn.accessToken;
    });

    it('lets a Manager create a group, add and remove members, audited; Support may not', async () => {
      const created = await gql(
        'mutation { createCustomerGroup(input: { name: "VIP", description: "Top customers" }) { id name memberCount } }',
        managerToken,
      );
      groupId = created.body.data.createCustomerGroup.id;
      const member = await newShopper();
      const leaver = await newShopper();

      const added = await gql(
        `mutation { addCustomerGroupMembers(input: { groupId: "${groupId}", userIds: ["${member}", "${leaver}", "${member}"] }) { memberCount } }`,
        managerToken,
      );
      const removed = await gql(
        `mutation { removeCustomerGroupMembers(input: { groupId: "${groupId}", userIds: ["${leaver}"] }) { memberCount } }`,
        managerToken,
      );
      const read = await gql(
        `query { customerGroup(id: "${groupId}") { name members { totalCount nodes { userId } } } }`,
        managerToken,
      );
      const forbidden = await gql('query { customerGroups { id } }', supportToken);

      expect(added.body.data.addCustomerGroupMembers.memberCount).toBe(2);
      expect(removed.body.data.removeCustomerGroupMembers.memberCount).toBe(1);
      expect(read.body.data.customerGroup).toEqual({
        name: 'VIP',
        members: { totalCount: 1, nodes: [{ userId: member }] },
      });
      expect(forbidden.body.errors[0].extensions.code).toBe('FORBIDDEN');
      const actions = await prisma.auditLog.findMany({
        where: { entity: 'CustomerGroup', entityId: groupId },
        orderBy: { createdAt: 'asc' },
      });
      expect(actions.map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
    });

    it('applies a group-only promotion to members only, and refuses its code to others', async () => {
      await createPromotion(prisma, {
        id: 'vip_only',
        type: 'PERCENT',
        value: 20,
        targetIds: ['seed_prod2'],
        stackingGroup: 'vip',
        customerGroups: { connect: [{ id: groupId }] },
      } as never);
      await createCoupon(prisma, {
        code: 'VIPCODE',
        type: 'AMOUNT_OFF',
        value: 3,
        customerGroups: { connect: [{ id: groupId }] },
      } as never);
      const member = (await prisma.customerGroupMember.findFirstOrThrow({ where: { groupId } })).userId;
      await fillCart(member);
      const outsider = await newShopper();

      expect(applied(await orders.checkoutQuote(member, { ...pickup, couponCode: 'vipcode' }))).toEqual(
        expect.arrayContaining(['vip_only', expect.any(String)]),
      );
      expect(applied(await orders.checkoutQuote(outsider, pickup))).not.toContain('vip_only');
      await expect(orders.checkoutQuote(outsider, { ...pickup, couponCode: 'vipcode' })).rejects.toThrow(
        'This coupon is not available for your account',
      );
    });

    it('refuses to delete a group a promotion is limited to', async () => {
      const res = await gql(`mutation { deleteCustomerGroup(id: "${groupId}") { id } }`, managerToken);

      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
    });
  });
});
