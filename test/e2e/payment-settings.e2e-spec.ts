import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { Redis } from 'ioredis';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, takeOrderNumber } from '../helpers/db.helper';
import { ANY_QUOTE_HASH } from '../helpers/checkout.helper';

// Not real keys: the right shape for Paystack test mode, made up for this suite.
const DB_SECRET = 'sk_test_e2eStoreSecret0001';
const DB_PUBLIC = 'pk_test_e2eStorePublic0001';

describe('Store payment settings (P3-A.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let ownerToken: string;
  let managerToken: string;
  let customerToken: string;
  let orderCount = 0;

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

  const SETTINGS = `{ methods { cardPaymentsEnabled mobileMoneyPaymentsEnabled cashOnDeliveryEnabled cardPaymentProvider }
    paystack { configured source mode secretKeyLast4 publicKey callbackUrl updatedAt updatedById } }`;
  const setConfig = (token: string, input: Record<string, unknown>) =>
    gql(`mutation ($input: SetPaystackConfigInput!) { setPaystackConfig(input: $input) ${SETTINGS} }`, token, {
      input,
    });
  const updateMethods = (token: string, input: Record<string, unknown>) =>
    gql(`mutation ($input: UpdatePaymentMethodsInput!) { updatePaymentMethods(input: $input) ${SETTINGS} }`, token, {
      input,
    });
  const available = async () =>
    (await gql('{ availablePaymentMethods { cashOnDelivery online { method provider publicKey } } }')).body.data
      .availablePaymentMethods;

  const sign = (raw: string, secret: string) => createHmac('sha512', secret).update(raw).digest('hex');
  const deliver = (raw: string, signature: string) =>
    request(app.getHttpServer())
      .post('/payment/webhook')
      .set('Content-Type', 'application/json')
      .set('x-paystack-signature', signature)
      .send(raw);

  const onlineOrder = async () => {
    orderCount += 1;
    const order = await prisma.order.create({
      data: {
        orderNumber: await takeOrderNumber(prisma),
        userId: 'seed_user',
        grandTotal: 100,
        currency: 'GHS',
        pricingVersion: 0,
        contactEmail: 'user@example.com',
        contactPhone: `+23324470${String(orderCount).padStart(4, '0')}`,
      },
    });
    return order.id;
  };
  const initiate = (orderId: string, paymentMethod: string) =>
    request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ orderId, paymentMethod });

  const quote = (paymentMethod: string) =>
    gql(
      `{ checkoutQuote(input: { fulfillmentType: PICKUP, pickupLocationId: "none", paymentMethod: ${paymentMethod} }) { quoteHash } }`,
      customerToken,
    );
  const placeOrder = (paymentMethod: string) =>
    gql(
      `mutation { createOrder(input: { fulfillmentType: PICKUP, pickupLocationId: "none", paymentMethod: ${paymentMethod},
        contactEmail: "user@example.com", contactPhone: "+233244000001", quoteHash: "${ANY_QUOTE_HASH}" }) { id } }`,
      customerToken,
    );

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    redis = app.get(REDIS_CLIENT);
    await resetDb(prisma);
    await seedMinimal(prisma);
    ownerToken = await signInSuperAdmin(app);
    managerToken = await signInAdmin(app);
    customerToken = await signInUser(app);
  });

  beforeEach(() => jest.clearAllMocks());

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  describe('defaults (nothing configured)', () => {
    it('offers every method, online through the PAYSTACK_SECRET_KEY fallback', async () => {
      expect(await available()).toEqual({
        cashOnDelivery: true,
        online: [
          { method: 'CARD', provider: 'PAYSTACK', publicKey: null },
          { method: 'MOBILE_MONEY', provider: 'PAYSTACK', publicKey: null },
        ],
      });
      const { paystack: view } = (await gql(`{ paymentSettings ${SETTINGS} }`, ownerToken)).body.data.paymentSettings;
      expect(view).toMatchObject({ configured: true, source: 'ENVIRONMENT', mode: 'TEST', updatedAt: null });
    });
  });

  describe('access', () => {
    it.each([
      ['a Manager', () => managerToken],
      ['a customer', () => customerToken],
    ])('refuses %s every payment-settings operation with FORBIDDEN', async (_who, token) => {
      const operations = [
        `{ paymentSettings ${SETTINGS} }`,
        `mutation { setPaystackConfig(input: { secretKey: "${DB_SECRET}" }) { paystack { configured } } }`,
        'mutation { removePaystackConfig { paystack { configured } } }',
        'mutation { updatePaymentMethods(input: { cashOnDeliveryEnabled: false }) { paystack { configured } } }',
      ];
      for (const operation of operations) {
        expect(errorOf(await gql(operation, token()))?.code).toBe('FORBIDDEN');
      }
    });

    it('needs a recent step-up from the Owner for every change, not for the read', async () => {
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      expect(errorOf(await setConfig(ownerToken, { secretKey: DB_SECRET }))?.reason).toBe('STEP_UP_REQUIRED');
      expect(errorOf(await updateMethods(ownerToken, { cashOnDeliveryEnabled: false }))?.reason).toBe(
        'STEP_UP_REQUIRED',
      );
      expect(
        errorOf(await gql('mutation { removePaystackConfig { paystack { configured } } }', ownerToken))?.reason,
      ).toBe('STEP_UP_REQUIRED');
      expect((await gql(`{ paymentSettings ${SETTINGS} }`, ownerToken)).body.errors).toBeUndefined();
      expect(await prisma.paymentProviderConfig.count()).toBe(0);
      ownerToken = await signInSuperAdmin(app);
    });
  });

  describe('Paystack config in the database', () => {
    it('refuses a public key of the other mode', async () => {
      const res = await setConfig(ownerToken, { secretKey: DB_SECRET, publicKey: 'pk_live_e2ePublic' });
      expect(errorOf(res)).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('LIVE key') });
    });

    it('stores the keys encrypted and returns only the last 4 characters of the secret', async () => {
      const res = await setConfig(ownerToken, {
        secretKey: DB_SECRET,
        publicKey: DB_PUBLIC,
        callbackUrl: 'https://shop.test/paid',
      });

      expect(res.body.errors).toBeUndefined();
      const owner = await prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
      expect(res.body.data.setPaystackConfig.paystack).toMatchObject({
        configured: true,
        source: 'DATABASE',
        mode: 'TEST',
        secretKeyLast4: '0001',
        publicKey: DB_PUBLIC,
        callbackUrl: 'https://shop.test/paid',
        updatedById: owner.id,
      });
      expect(JSON.stringify(res.body)).not.toContain(DB_SECRET);

      const row = await prisma.paymentProviderConfig.findFirstOrThrow();
      expect(row.encryptedSecretKey).not.toContain(DB_SECRET);
      expect(row.encryptedSecretKey).toMatch(/^v1\./);

      const audits = await prisma.auditLog.findMany({ where: { entity: 'PaymentProviderConfig' } });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ action: 'CREATE', userId: owner.id });
      expect(JSON.stringify(audits)).not.toContain(DB_SECRET);
    });

    it('shows customers the public key, never the secret', async () => {
      const methods = await available();
      expect(methods.online[0]).toEqual({ method: 'CARD', provider: 'PAYSTACK', publicKey: DB_PUBLIC });
      expect(JSON.stringify(methods)).not.toContain(DB_SECRET);
    });

    it('accepts a webhook signed with the stored secret and refuses one signed with the environment secret', async () => {
      const raw = (id: number) => `{"event":"refund.processed","data":{"id":${id},"reference":"settings-ref"}}`;

      await deliver(raw(1), sign(raw(1), process.env.PAYSTACK_SECRET_KEY!)).expect(401);
      await deliver(raw(2), sign(raw(2), DB_SECRET)).expect(200);

      const events = await prisma.webhookEvent.findMany({ where: { reference: 'settings-ref' } });
      expect(events.map((event) => event.eventKey)).toEqual(['refund.processed:id:2']);
    });

    it('opens checkouts with the stored callback URL, limited to the chosen channel', async () => {
      const orderId = await onlineOrder();

      await initiate(orderId, 'MOBILE_MONEY').expect(201);

      expect(paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ callback_url: 'https://shop.test/paid', channels: ['mobile_money'] }),
      );
      const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { intent: { orderId } } });
      expect(attempt).toMatchObject({ provider: 'PAYSTACK', channel: 'MOBILE_MONEY' });
    });

    it('falls back to the environment again once the stored config is removed', async () => {
      const res = await gql(`mutation { removePaystackConfig ${SETTINGS} }`, ownerToken);

      expect(res.body.data.removePaystackConfig.paystack).toMatchObject({ source: 'ENVIRONMENT', publicKey: null });
      expect(await prisma.paymentProviderConfig.count()).toBe(0);
      const raw = '{"event":"refund.processed","data":{"id":3,"reference":"settings-ref"}}';
      await deliver(raw, sign(raw, process.env.PAYSTACK_SECRET_KEY!)).expect(200);
      expect(await prisma.auditLog.count({ where: { entity: 'PaymentProviderConfig', action: 'DELETE' } })).toBe(1);
    });
  });

  describe('payment methods switched off', () => {
    afterAll(async () => {
      await updateMethods(ownerToken, {
        cardPaymentsEnabled: true,
        mobileMoneyPaymentsEnabled: true,
        cashOnDeliveryEnabled: true,
      });
    });

    it('refuses cash on delivery at checkoutQuote and createOrder, before touching the cart', async () => {
      const res = await updateMethods(ownerToken, { cashOnDeliveryEnabled: false });
      expect(res.body.data.updatePaymentMethods.methods.cashOnDeliveryEnabled).toBe(false);

      for (const refused of [await quote('CASH_ON_DELIVERY'), await placeOrder('CASH_ON_DELIVERY')]) {
        expect(errorOf(refused)).toMatchObject({ code: 'BAD_REQUEST', reason: 'PAYMENT_METHOD_UNAVAILABLE' });
      }
      expect((await available()).cashOnDelivery).toBe(false);
      expect(
        await prisma.auditLog.findFirst({
          where: { entity: 'Store', action: 'UPDATE' },
          orderBy: { createdAt: 'desc' },
        }),
      ).toMatchObject({ details: { changes: { cashOnDeliveryEnabled: { from: true, to: false } } } });
    });

    it('refuses a switched-off online method at initiatePayment, and ONLINE orders once none is left', async () => {
      await updateMethods(ownerToken, { mobileMoneyPaymentsEnabled: false });
      const orderId = await onlineOrder();

      const refused = await initiate(orderId, 'MOBILE_MONEY').expect(400);
      expect(refused.body.message).toBe('Mobile money payment is not available at this store');
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
      await initiate(orderId, 'CARD').expect(201);

      await updateMethods(ownerToken, { cardPaymentsEnabled: false });
      expect((await available()).online).toEqual([]);
      for (const refusedOrder of [await quote('ONLINE'), await placeOrder('ONLINE')]) {
        expect(errorOf(refusedOrder)).toMatchObject({ code: 'BAD_REQUEST', reason: 'PAYMENT_METHOD_UNAVAILABLE' });
      }
    });
  });
});
