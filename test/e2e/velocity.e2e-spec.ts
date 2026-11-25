import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { relaxVelocityLimits, resetDb, seedMinimal, setStock, takeOrderNumber } from '../helpers/db.helper';

const PHONE = '+233244000001';
const NATIONAL_PHONE = '0244000001';

describe('Velocity checks (P3-E.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let ownerToken: string;
  let managerToken: string;
  let customerToken: string;

  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
  };

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const errorOf = (res: { body: { errors?: { message: string; extensions: { code: string; reason?: string } }[] } }) =>
    res.body.errors?.[0] && { ...res.body.errors[0].extensions, message: res.body.errors[0].message };

  const LIMIT_FIELDS = '{ rule event subject windowSeconds softLimit hardLimit isDefault }';
  const setLimits = (limits: { rule: string; softLimit: number; hardLimit: number }[], token = ownerToken) =>
    gql(
      `mutation ($input: UpdateVelocityLimitsInput!) { updateVelocityLimits(input: $input) ${LIMIT_FIELDS} }`,
      token,
      {
        input: { limits },
      },
    );

  const placeOrder = async () => {
    await gql('mutation { addToCart(input: { variantId: "seed_var1", quantity: 1 }) { id } }', customerToken);
    const pickup = 'fulfillmentType: PICKUP, pickupLocationId: "velocity_pickup"';
    const quote = await gql(`{ checkoutQuote(input: { ${pickup} }) { quoteHash } }`, customerToken);
    return gql(
      `mutation { createOrder(input: { ${pickup}, contactEmail: "user@example.com", contactPhone: "${PHONE}",
        quoteHash: "${quote.body.data.checkoutQuote.quoteHash}" }) { id } }`,
      customerToken,
    );
  };

  const FLAGGED = '{ id orderNumber status reviewFlags { id orderId rule level count limit clearedAt } }';
  const flaggedOrders = async (token = managerToken) =>
    (await gql(`{ flaggedOrders ${FLAGGED} }`, token)).body.data.flaggedOrders as {
      id: string;
      reviewFlags: { rule: string; level: string; count: number; limit: number }[];
    }[];

  const velocityKeys = async () => {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', 'velocity:*', 'COUNT', 1000);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  };

  let orderCount = 0;
  const unpaidOrder = async () => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324480${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };
  const initiate = (orderId: string) =>
    request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ orderId, paymentMethod: 'CARD' });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    redis = app.get(REDIS_CLIENT);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await setStock(prisma, 'seed_var1', 100);
    await prisma.pickupLocation.create({
      data: {
        id: 'velocity_pickup',
        name: 'Osu Store',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    ownerToken = await signInSuperAdmin(app);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  beforeEach(async () => {
    const keys = await velocityKeys();
    if (keys.length) await redis.del(...keys);
    await relaxVelocityLimits(prisma);
    await prisma.orderReviewFlag.deleteMany();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('limits (store settings)', () => {
    it('shows every rule with its window, and the code defaults until the Owner sets limits', async () => {
      await prisma.velocityLimit.deleteMany();

      const limits = (await gql(`{ velocityLimits ${LIMIT_FIELDS} }`, ownerToken)).body.data.velocityLimits;

      expect(limits).toHaveLength(10);
      expect(limits).toContainEqual({
        rule: 'ORDERS_PER_CUSTOMER_1H',
        event: 'ORDER_PLACED',
        subject: 'CUSTOMER',
        windowSeconds: 3600,
        softLimit: 3,
        hardLimit: 6,
        isDefault: true,
      });
      expect(limits).toContainEqual(
        expect.objectContaining({ rule: 'FAILED_PAYMENTS_PER_CARD_24H', subject: 'CARD', windowSeconds: 86400 }),
      );
    });

    it('lets the Owner set limits, audited, and refuses a hard limit below the soft one', async () => {
      const updated = (await setLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80 }])).body.data
        .updateVelocityLimits;

      expect(updated).toContainEqual(
        expect.objectContaining({ rule: 'ORDERS_PER_IP_1H', softLimit: 50, hardLimit: 80, isDefault: false }),
      );
      const audit = await prisma.auditLog.findFirst({
        where: { entity: 'VelocityLimit' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.details).toMatchObject({
        changes: { ORDERS_PER_IP_1H: { to: { softLimit: 50, hardLimit: 80 } } },
      });

      const refused = await setLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 5, hardLimit: 4 }]);
      expect(errorOf(refused)).toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('hardLimit (4)'),
      });
      const zero = await setLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 0, hardLimit: 4 }]);
      expect(errorOf(zero)?.code).toBe('BAD_USER_INPUT');
    });

    it.each([
      ['a Manager', () => managerToken],
      ['a customer', () => customerToken],
    ])('refuses %s reading or setting limits', async (_who, token) => {
      expect(errorOf(await gql(`{ velocityLimits ${LIMIT_FIELDS} }`, token()))?.code).toBe('FORBIDDEN');
      expect(errorOf(await setLimits([{ rule: 'ORDERS_PER_IP_1H', softLimit: 1, hardLimit: 2 }], token()))?.code).toBe(
        'FORBIDDEN',
      );
    });
  });

  describe('order placement', () => {
    it('flags orders above the soft limit and refuses the one above the hard limit, with nothing placed', async () => {
      await setLimits([{ rule: 'ORDERS_PER_CUSTOMER_1H', softLimit: 1, hardLimit: 2 }]);

      const first = await placeOrder();
      const second = await placeOrder();
      const ordersBefore = await prisma.order.count();
      const refused = await placeOrder();

      expect(errorOf(first)).toBeUndefined();
      expect(errorOf(second)).toBeUndefined();
      expect(errorOf(refused)).toMatchObject({
        code: 'FORBIDDEN',
        reason: 'VELOCITY_LIMIT',
        message: expect.stringContaining('Too many orders'),
      });
      expect(await prisma.order.count()).toBe(ordersBefore);

      const flagged = await flaggedOrders();
      expect(flagged).toEqual([
        expect.objectContaining({
          id: second.body.data.createOrder.id,
          reviewFlags: [
            expect.objectContaining({
              rule: 'ORDERS_PER_CUSTOMER_1H',
              level: 'SOFT',
              count: 2,
              limit: 1,
              clearedAt: null,
            }),
          ],
        }),
      ]);
    });

    it('counts the phone and IP under SHA-256 keys: no raw phone number, IP address or customer id in Redis', async () => {
      await placeOrder();

      const keys = await velocityKeys();
      expect(keys.map((key) => key.split(':')[1]).sort()).toEqual([
        'ORDERS_PER_CUSTOMER_1H',
        'ORDERS_PER_CUSTOMER_24H',
        'ORDERS_PER_IP_1H',
        'ORDERS_PER_IP_24H',
        'ORDERS_PER_PHONE_24H',
      ]);
      for (const key of keys) {
        expect(key).toMatch(/^velocity:[A-Z0-9_]+:[0-9a-f]{64}$/);
        for (const raw of [PHONE, NATIONAL_PHONE, '233244000001', '127.0.0.1', '::1', 'seed_user']) {
          expect(key).not.toContain(raw);
        }
        expect(await redis.get(key)).toBe('1');
        expect(await redis.ttl(key)).toBeGreaterThan(0);
      }
    });
  });

  describe('payment initiation', () => {
    it('flags the order above the soft limit and refuses the attempt above the hard limit', async () => {
      await setLimits([{ rule: 'PAYMENT_ATTEMPTS_PER_CUSTOMER_1H', softLimit: 1, hardLimit: 2 }]);
      const [first, second, third] = [await unpaidOrder(), await unpaidOrder(), await unpaidOrder()];

      await initiate(first).expect(201);
      await initiate(second).expect(201);
      const refused = await initiate(third).expect(403);

      expect(refused.body).toMatchObject({
        reason: 'VELOCITY_LIMIT',
        message: expect.stringContaining('payment attempts'),
      });
      expect(await prisma.paymentAttempt.count({ where: { intent: { orderId: third } } })).toBe(0);
      expect((await flaggedOrders()).map(({ id, reviewFlags }) => [id, reviewFlags.map(({ rule }) => rule)])).toEqual([
        [second, ['PAYMENT_ATTEMPTS_PER_CUSTOMER_1H']],
      ]);
    });
  });

  describe('review flags (staff)', () => {
    it("lets staff clear an order's flags with a note, audited; the order leaves the list", async () => {
      await setLimits([{ rule: 'ORDERS_PER_CUSTOMER_1H', softLimit: 1, hardLimit: 10 }]);
      await placeOrder();
      const orderId = (await placeOrder()).body.data.createOrder.id as string;
      const clear = (token: string) =>
        gql(
          `mutation ($input: ClearOrderReviewFlagsInput!) { clearOrderReviewFlags(input: $input) { orderId rule clearedAt clearedById clearNote } }`,
          token,
          { input: { orderId, note: 'Known customer buying gifts' } },
        );

      expect(errorOf(await clear(customerToken))?.code).toBe('FORBIDDEN');
      expect(errorOf(await gql(`{ flaggedOrders ${FLAGGED} }`, customerToken))?.code).toBe('FORBIDDEN');

      const cleared = (await clear(managerToken)).body.data.clearOrderReviewFlags;
      expect(cleared).toEqual([
        {
          orderId,
          rule: 'ORDERS_PER_CUSTOMER_1H',
          clearedAt: expect.any(String),
          clearedById: 'seed_admin',
          clearNote: 'Known customer buying gifts',
        },
      ]);
      expect(await flaggedOrders()).toEqual([]);
      expect(await prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId } })).toMatchObject({
        action: 'UPDATE',
        userId: 'seed_admin',
      });
      expect(errorOf(await clear(managerToken))?.code).toBe('NOT_FOUND');
    });
  });
});
