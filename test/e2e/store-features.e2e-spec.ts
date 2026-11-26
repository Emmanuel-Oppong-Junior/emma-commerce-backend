import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { AbandonedCartTask } from '../../src/cart/abandoned/abandoned-cart.task';
import { FEATURES_CACHE_KEY } from '../../src/store-features/store-features.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';

// Store-level feature switches (P8-F): the public list, the Owner's switch (permission, step-up, audit), the gated
// operations of each feature refusing with FEATURE_DISABLED while it is off, and the switch reaching every check at once.

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string; feature?: string } }[];
}

const FEATURE_KEYS = [
  'GUEST_CHECKOUT',
  'LOYALTY',
  'REFERRALS',
  'REVIEWS',
  'PRODUCT_QA',
  'RECENTLY_VIEWED',
  'RETURNS',
  'ABANDONED_CART_REMINDERS',
  'SAVED_FOR_LATER',
  'WISHLIST',
  'CASH_ON_DELIVERY',
];
const HOUR = 60 * 60 * 1000;

describe('Store features (P8-F, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let ownerToken: string;
  let managerToken: string;
  let userToken: string;

  const gql = async (query: string, token = userToken): Promise<GqlResult> =>
    (await gqlRequest(app, query, undefined, token).expect(200)).body;
  const errorOf = (result: GqlResult) => result.errors?.[0]?.extensions;
  const setFeature = (key: string, enabled: boolean, token = ownerToken) =>
    gql(`mutation { setStoreFeature(input: { key: ${key}, enabled: ${enabled} }) { key enabled description } }`, token);
  const switchFeature = async (key: string, enabled: boolean) => {
    const result = await setFeature(key, enabled);
    expect(result.errors).toBeUndefined();
  };
  const features = async () =>
    Object.fromEntries(
      (
        (await gql(`{ storeFeatures { key enabled } }`, '')).data!.storeFeatures as { key: string; enabled: boolean }[]
      ).map((feature) => [feature.key, feature.enabled]),
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    redis = app.get<Redis>(REDIS_CLIENT);
    await resetDb(prisma);
    await seedMinimal(prisma);
    ownerToken = await signInSuperAdmin(app);
    managerToken = await signInAdmin(app);
    userToken = await signInUser(app);
  });

  afterAll(async () => {
    for (const key of FEATURE_KEYS) await setFeature(key, true);
    await resetDb(prisma);
    await app.close();
  });

  it('lists every feature publicly, all on by default, cash on delivery from the payment method switch', async () => {
    const listed = await gql(`{ storeFeatures { key enabled description } }`, '');

    expect(listed.errors).toBeUndefined();
    expect(listed.data!.storeFeatures.map((feature: { key: string }) => feature.key)).toEqual(FEATURE_KEYS);
    expect(Object.values(await features()).every(Boolean)).toBe(true);

    await prisma.store.updateMany({ data: { cashOnDeliveryEnabled: false } });
    expect((await features()).CASH_ON_DELIVERY).toBe(false);
    await prisma.store.updateMany({ data: { cashOnDeliveryEnabled: true } });
  });

  it('lets only the Owner switch a feature, after a recent step-up, audited with before and after', async () => {
    expect(errorOf(await setFeature('WISHLIST', false, managerToken))?.code).toBe('FORBIDDEN');
    expect(errorOf(await setFeature('WISHLIST', false, userToken))?.code).toBe('FORBIDDEN');
    expect(errorOf(await setFeature('WISHLIST', false, ''))?.code).toBe('UNAUTHENTICATED');

    const keys = await redis.keys('mfa:step-up:*');
    if (keys.length > 0) await redis.del(...keys);
    expect(errorOf(await setFeature('WISHLIST', false))?.reason).toBe('STEP_UP_REQUIRED');
    ownerToken = await signInSuperAdmin(app);

    const switched = await setFeature('WISHLIST', false);
    expect(switched.data!.setStoreFeature).toMatchObject({ key: 'WISHLIST', enabled: false });
    expect(await prisma.storeFeature.findFirst({ where: { key: 'WISHLIST' } })).toMatchObject({
      enabled: false,
      updatedById: 'seed_super_admin',
    });
    const audit = await prisma.auditLog.findFirst({ where: { entity: 'StoreFeature', entityId: 'WISHLIST' } });
    expect(audit).toMatchObject({
      action: 'UPDATE',
      userId: 'seed_super_admin',
      details: { changes: { enabled: { from: true, to: false } } },
    });
    await switchFeature('WISHLIST', true);
  });

  it('switches cash on delivery through the Store payment method column, without a feature row', async () => {
    await switchFeature('CASH_ON_DELIVERY', false);
    expect(await prisma.store.findFirstOrThrow({ select: { cashOnDeliveryEnabled: true } })).toEqual({
      cashOnDeliveryEnabled: false,
    });
    expect(
      (await gql(`{ availablePaymentMethods { cashOnDelivery } }`, '')).data!.availablePaymentMethods.cashOnDelivery,
    ).toBe(false);
    expect(await prisma.storeFeature.count({ where: { key: 'CASH_ON_DELIVERY' } })).toBe(0);
    await switchFeature('CASH_ON_DELIVERY', true);
    expect((await features()).CASH_ON_DELIVERY).toBe(true);
  });

  describe.each([
    ['WISHLIST', `mutation { addToWishlist(productId: "seed_prod1") { id } }`],
    ['RECENTLY_VIEWED', `mutation { recordProductView(productId: "seed_prod1") }`],
    ['SAVED_FOR_LATER', `mutation { saveCartItemForLater(cartItemId: "no_such_line") { id } }`],
    ['REFERRALS', `mutation { applyReferralCode(input: { code: "ABCDEFGH" }) { code } }`],
    ['REFERRALS', `{ myReferrals { code } }`],
    ['REVIEWS', `mutation { createReview(input: { productId: "seed_prod1", score: 5 }) { id } }`],
    ['REVIEWS', `mutation { reportReview(input: { id: "no_such_review", reason: SPAM }) }`],
    ['PRODUCT_QA', `mutation { askProductQuestion(input: { productId: "seed_prod1", body: "Does it fit?" }) { id } }`],
    [
      'RETURNS',
      `mutation { requestReturn(input: { orderId: "no_such_order", lines: [{ orderItemId: "x", quantity: 1, reason: DAMAGED }] }) { id } }`,
    ],
    ['RETURNS', `mutation { cancelReturn(returnRequestId: "no_such_return") { id } }`],
    ['GUEST_CHECKOUT', `mutation { createGuestCart { guestCartToken } }`],
  ])('%s off', (key, operation) => {
    it(`refuses ${operation.slice(0, 60)}… with FEATURE_DISABLED, and lets it through again once on`, async () => {
      const token = key === 'GUEST_CHECKOUT' ? '' : userToken;
      await switchFeature(key, false);
      const refused = await gql(operation, token);
      expect(errorOf(refused)).toMatchObject({ code: 'BAD_REQUEST', reason: 'FEATURE_DISABLED', feature: key });

      await switchFeature(key, true);
      expect(errorOf(await gql(operation, token))?.reason).not.toBe('FEATURE_DISABLED');
    });
  });

  it('refuses the gated photo uploads over REST with FEATURE_DISABLED', async () => {
    await switchFeature('REVIEWS', false);
    await switchFeature('RETURNS', false);

    for (const path of ['/reviews/no_such_review/photos', '/returns/orders/no_such_order/photos']) {
      const res = await request(app.getHttpServer()).post(path).set('Authorization', `Bearer ${userToken}`).expect(400);
      expect(res.body).toMatchObject({ reason: 'FEATURE_DISABLED' });
    }
    await switchFeature('REVIEWS', true);
    await switchFeature('RETURNS', true);
  });

  it('keeps reads and staff work open, and the data, while a feature is off', async () => {
    await prisma.wishList.upsert({
      where: { userId: 'seed_user' },
      create: { userId: 'seed_user', products: { connect: [{ id: 'seed_prod1' }] } },
      update: { products: { set: [{ id: 'seed_prod1' }] } },
    });
    await switchFeature('WISHLIST', false);
    await switchFeature('REVIEWS', false);
    await switchFeature('GUEST_CHECKOUT', false);

    const wishlist = await gql(`{ wishlist { products { id } } }`);
    expect(wishlist.data!.wishlist.products).toEqual([{ id: 'seed_prod1' }]);
    expect((await gql(`{ productReviews(productId: "seed_prod1") { id } }`, '')).errors).toBeUndefined();
    expect((await gql(`{ reportedReviews { review { id } } }`, managerToken)).errors).toBeUndefined();
    expect(errorOf(await gql(`{ guestCart(guestCartToken: "gct_unknown") { id } }`, ''))?.code).toBe('NOT_FOUND');

    await switchFeature('WISHLIST', true);
    await switchFeature('REVIEWS', true);
    await switchFeature('GUEST_CHECKOUT', true);
    expect((await gql(`{ wishlist { products { id } } }`)).data!.wishlist.products).toEqual([{ id: 'seed_prod1' }]);
  });

  it('refuses a referral code at sign-up while referrals are off, before creating the account', async () => {
    await switchFeature('REFERRALS', false);
    const signUp = await gql(
      `mutation { signUp(input: { name: "Esi", email: "esi.flags@example.com", password: "Referral@1234", referralCode: "ABCDEFGH" }) { accessToken } }`,
      '',
    );
    expect(errorOf(signUp)).toMatchObject({ reason: 'FEATURE_DISABLED', feature: 'REFERRALS' });
    expect(await prisma.user.count({ where: { email: 'esi.flags@example.com' } })).toBe(0);
    await switchFeature('REFERRALS', true);
  });

  it('records no abandoned-cart reminder while reminders are off, and reminds again once on', async () => {
    const task = app.get(AbandonedCartTask);
    await prisma.notificationPreference.create({
      data: { userId: 'seed_user', category: 'MARKETING', channel: 'EMAIL', enabled: true },
    });
    await gql(`mutation { addToCart(input: { variantId: "seed_var1", quantity: 1 }) { id } }`);
    await prisma.cartItem.updateMany({
      where: { cart: { userId: 'seed_user' } },
      data: { updatedAt: new Date(Date.now() - 5 * HOUR) },
    });

    await switchFeature('ABANDONED_CART_REMINDERS', false);
    expect(await task.run()).toBeNull();
    expect(await prisma.abandonedCartReminder.count()).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { type: 'cart.abandoned_reminder.v1' } })).toBe(0);

    await switchFeature('ABANDONED_CART_REMINDERS', true);
    expect(await task.run()).toMatchObject({ reminded: 1 });
  });

  it('reaches every check at once: a change clears the cached switches', async () => {
    const add = `mutation { addToWishlist(productId: "seed_prod2") { id } }`;
    expect((await gql(add)).errors).toBeUndefined();
    expect(await redis.get(FEATURES_CACHE_KEY)).not.toBeNull();

    for (const enabled of [false, true, false, true]) {
      await switchFeature('WISHLIST', enabled);
      expect(errorOf(await gql(add))?.reason === 'FEATURE_DISABLED').toBe(!enabled);
    }

    await redis.set(FEATURES_CACHE_KEY, JSON.stringify({ WISHLIST: false }), 'PX', 60_000);
    expect(errorOf(await gql(add))?.reason).toBe('FEATURE_DISABLED');
    await switchFeature('WISHLIST', true);
    expect(errorOf(await gql(add))?.reason).toBeUndefined();
  });
});
