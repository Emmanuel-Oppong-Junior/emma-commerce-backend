import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { createTestApp } from '../helpers/app.helper';
import { ghs, gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signInSuperAdmin, signInUser, signUpUser } from '../helpers/auth.helper';
import { createCoupon, createPromotion } from '../helpers/promotion.helper';

const PROMOTION_FIELDS = `id name scope type value targetIds minimumSpend { amount } startsAt endsAt isActive priority
  stackingGroup exclusive requiresCoupon usageLimit usedCount perCustomerLimit couponCodes { id code usedCount }`;

describe('Promotions admin API (P2-B.1, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let managerToken: string;
  let supportToken: string;
  let customerToken: string;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const codeOf = (res: { body: { errors?: { extensions: { code: string; reason?: string } }[] } }) =>
    res.body.errors?.[0].extensions;
  const audit = (entity: string, entityId: string) =>
    prisma.auditLog.findMany({ where: { entity, entityId }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    redis = app.get(REDIS_CLIENT);
    await resetDb(prisma);
    await seedMinimal(prisma);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
    const ownerToken = await signInSuperAdmin(app);
    await signUpUser(app, { email: 'promo-support@example.com', password: 'Passw0rd!x', name: 'Support' });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email: 'promo-support@example.com' } });
    await gql(`mutation { assignStaffRole(userId: "${id}", roleKey: "SUPPORT") { role { key } } }`, ownerToken);
    const signedIn = await gql(
      'mutation S($input: SignInInput!) { signIn(input: $input) { accessToken } }',
      undefined,
      { input: { email: 'promo-support@example.com', password: 'Passw0rd!x' } },
    );
    supportToken = signedIn.body.data.signIn.accessToken;
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('creates, reads, updates and deletes a promotion with its targets, auditing each change', async () => {
    const created = await gql(
      `mutation { createPromotion(input: {
        name: "Laptop week", scope: PRODUCT, type: PERCENT, value: "15", targetIds: ["seed_prod1"],
        minimumSpend: "100", isActive: true, priority: 2, stackingGroup: "sales", perCustomerLimit: 3
      }) { ${PROMOTION_FIELDS} } }`,
      managerToken,
    );
    expect(created.body.errors).toBeUndefined();
    const promotion = created.body.data.createPromotion;
    expect(promotion).toMatchObject({
      name: 'Laptop week',
      scope: 'PRODUCT',
      type: 'PERCENT',
      value: '15',
      targetIds: ['seed_prod1'],
      minimumSpend: { amount: '100.00' },
      isActive: true,
      priority: 2,
      stackingGroup: 'sales',
      exclusive: false,
      requiresCoupon: false,
      usageLimit: null,
      usedCount: 0,
      perCustomerLimit: 3,
      endsAt: null,
      couponCodes: [],
    });

    const retargeted = await gql(
      `mutation { updatePromotion(id: "${promotion.id}", input: { scope: SKU, targetIds: ["seed_var1", "seed_var2"], minimumSpend: null }) {
        scope targetIds minimumSpend { amount } name } }`,
      managerToken,
    );
    expect(retargeted.body.data.updatePromotion).toEqual({
      scope: 'SKU',
      targetIds: expect.arrayContaining(['seed_var1', 'seed_var2']),
      minimumSpend: null,
      name: 'Laptop week',
    });

    const listed = await gql('query { promotions(isActive: true, scope: SKU) { id } }', managerToken);
    expect(listed.body.data.promotions).toEqual([{ id: promotion.id }]);
    const one = await gql(`query { promotion(id: "${promotion.id}") { targetIds } }`, managerToken);
    expect(one.body.data.promotion.targetIds).toHaveLength(2);

    const deleted = await gql(`mutation { deletePromotion(id: "${promotion.id}") { id } }`, managerToken);
    expect(deleted.body.errors).toBeUndefined();
    expect(await prisma.promotion.count({ where: { id: promotion.id } })).toBe(0);
    expect((await audit('Promotion', promotion.id)).map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });

  it.each([
    ['a percentage above 100', 'scope: CART, type: PERCENT, value: "101"', 'at most 100'],
    ['a fixed cart price', 'scope: CART, type: FIXED_PRICE, value: "5"', 'FIXED_PRICE'],
    [
      'targets on a cart promotion',
      'scope: CART, type: AMOUNT_OFF, value: "5", targetIds: ["seed_prod1"]',
      'no targetIds',
    ],
    [
      'an unknown target',
      'scope: BRAND, type: AMOUNT_OFF, value: "5", targetIds: ["no_brand"]',
      'Unknown BRAND target',
    ],
  ])('refuses %s with BAD_REQUEST', async (_case, fields, message) => {
    const res = await gql(`mutation { createPromotion(input: { name: "Bad", ${fields} }) { id } }`, managerToken);

    expect(codeOf(res)?.code).toBe('BAD_REQUEST');
    expect(res.body.errors[0].message).toContain(message);
  });

  it('checks an update against the stored promotion: a percentage stays at most 100', async () => {
    const promotion = await createPromotion(prisma, { type: 'PERCENT', value: 10, targetIds: ['seed_prod1'] });

    const res = await gql(
      `mutation { updatePromotion(id: "${promotion.id}", input: { value: "150" }) { id } }`,
      managerToken,
    );

    expect(codeOf(res)?.code).toBe('BAD_REQUEST');
    expect((await prisma.promotion.findUniqueOrThrow({ where: { id: promotion.id } })).value.toFixed(0)).toBe('10');
  });

  it('manages coupon codes: stored upper case, unique ignoring case, audited, deletable only while unused', async () => {
    const promotion = await createPromotion(prisma, {
      scope: 'CART',
      type: 'AMOUNT_OFF',
      value: 5,
      requiresCoupon: true,
    });

    const created = await gql(
      `mutation { createCouponCode(input: { promotionId: "${promotion.id}", code: "welcome5", usageLimit: 100 }) {
        id code isActive usageLimit usedCount } }`,
      managerToken,
    );
    const code = created.body.data.createCouponCode;
    expect(code).toMatchObject({ code: 'WELCOME5', isActive: true, usageLimit: 100, usedCount: 0 });
    const duplicate = await gql(
      `mutation { createCouponCode(input: { promotionId: "${promotion.id}", code: "Welcome5" }) { id } }`,
      managerToken,
    );
    expect(codeOf(duplicate)?.code).toBe('CONFLICT');
    const updated = await gql(
      `mutation { updateCouponCode(id: "${code.id}", input: { isActive: false, usageLimit: null }) { isActive usageLimit } }`,
      managerToken,
    );
    expect(updated.body.data.updateCouponCode).toEqual({ isActive: false, usageLimit: null });
    const listed = await gql(`query { promotion(id: "${promotion.id}") { couponCodes { code } } }`, managerToken);
    expect(listed.body.data.promotion.couponCodes).toEqual([{ code: 'WELCOME5' }]);

    const deleted = await gql(`mutation { deleteCouponCode(id: "${code.id}") { id } }`, managerToken);
    expect(deleted.body.errors).toBeUndefined();
    expect((await audit('CouponCode', code.id)).map((row) => row.action)).toEqual(['CREATE', 'UPDATE', 'DELETE']);
  });

  it('refuses to delete a promotion or coupon code an order has used (deactivate instead)', async () => {
    const { promotion, couponCode } = await createCoupon(prisma, { code: 'USED1', type: 'AMOUNT_OFF', value: 1 });
    const order = await prisma.order.create({
      data: {
        orderNumber: 990001,
        userId: 'seed_user',
        currency: 'GHS',
        pricingVersion: 0,
        grandTotal: 10,
        contactEmail: 'user@example.com',
        contactPhone: '+233244000000',
      },
    });
    await prisma.redemption.create({
      data: { promotionId: promotion.id, couponCodeId: couponCode.id, customerId: 'seed_user', orderId: order.id },
    });

    const promotionRes = await gql(`mutation { deletePromotion(id: "${promotion.id}") { id } }`, managerToken);
    const codeRes = await gql(`mutation { deleteCouponCode(id: "${couponCode.id}") { id } }`, managerToken);

    expect(codeOf(promotionRes)?.code).toBe('CONFLICT');
    expect(codeOf(codeRes)?.code).toBe('CONFLICT');
    const redemptions = await gql(
      `query { redemptions(promotionId: "${promotion.id}") { totalCount nodes { orderId customerId couponCodeId status } } }`,
      managerToken,
    );
    expect(redemptions.body.data.redemptions).toEqual({
      totalCount: 1,
      nodes: [{ orderId: order.id, customerId: 'seed_user', couponCodeId: couponCode.id, status: 'RESERVED' }],
    });
  });

  it.each([
    ['a customer', () => customerToken],
    ['staff without promotion.manage (Support)', () => supportToken],
  ])('refuses %s every admin operation with FORBIDDEN', async (_who, token) => {
    const operations = [
      'query { promotions { id } }',
      'query { promotion(id: "x") { id } }',
      'query { redemptions { totalCount } }',
      'mutation { createPromotion(input: { name: "x", scope: CART, type: AMOUNT_OFF, value: "1" }) { id } }',
      'mutation { updatePromotion(id: "x", input: { name: "y" }) { id } }',
      'mutation { deletePromotion(id: "x") { id } }',
      'mutation { createCouponCode(input: { promotionId: "x", code: "X" }) { id } }',
      'mutation { updateCouponCode(id: "x", input: { isActive: false }) { id } }',
      'mutation { deleteCouponCode(id: "x") { id } }',
    ];
    for (const operation of operations) {
      expect(codeOf(await gql(operation, token()))?.code).toBe('FORBIDDEN');
    }
  });

  it('needs a recent step-up for every promotion and coupon code change, not for reads', async () => {
    const keys = await redis.keys('mfa:step-up:*');
    if (keys.length > 0) await redis.del(...keys);

    const changes = [
      'mutation { createPromotion(input: { name: "x", scope: CART, type: AMOUNT_OFF, value: "1" }) { id } }',
      'mutation { updatePromotion(id: "x", input: { name: "y" }) { id } }',
      'mutation { deletePromotion(id: "x") { id } }',
      'mutation { createCouponCode(input: { promotionId: "x", code: "X" }) { id } }',
      'mutation { updateCouponCode(id: "x", input: { isActive: false }) { id } }',
      'mutation { deleteCouponCode(id: "x") { id } }',
    ];
    for (const change of changes) {
      expect(codeOf(await gql(change, managerToken))?.reason).toBe('STEP_UP_REQUIRED');
    }
    expect((await gql('query { promotions { id } }', managerToken)).body.errors).toBeUndefined();
    managerToken = await signInAdmin(app);
  });

  it('shows customers only the public face of a promotion on a variant', async () => {
    await createPromotion(prisma, {
      name: 'Phone promo',
      description: 'Ten off phones',
      type: 'AMOUNT_OFF',
      value: 10,
      targetIds: ['seed_prod2'],
      usageLimit: 500,
      priority: 4,
    });
    await createPromotion(prisma, {
      name: 'Secret code deal',
      type: 'AMOUNT_OFF',
      value: 50,
      targetIds: ['seed_prod2'],
      requiresCoupon: true,
    });

    const res = await gql(
      'query { product(productId: "seed_prod2") { variants { price { amount } discountedPrice { amount currency } appliedPromotion { name description endsAt } } } }',
    );
    const leaking = await gqlRequest(
      app,
      'query { product(productId: "seed_prod2") { variants { appliedPromotion { usageLimit } } } }',
    ).expect(400);

    expect(res.body.errors).toBeUndefined();
    const [variant] = res.body.data.product.variants;
    expect(variant.appliedPromotion).toEqual({
      name: 'Phone promo',
      description: 'Ten off phones',
      endsAt: expect.any(String),
    });
    expect(variant.price).toEqual({ amount: '499.99' });
    expect(variant.discountedPrice).toEqual(ghs('489.99'));
    expect(codeOf(leaking)?.code).toBe('GRAPHQL_VALIDATION_FAILED');
  });
});
