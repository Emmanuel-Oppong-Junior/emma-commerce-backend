import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { LoggerService } from '../../src/commons/logger.service';
import { AppMetrics } from '../../src/observability/metrics';
import { SMS_PROVIDER } from '../../src/notifications/sms/sms-provider.port';
import { otpKeys } from '../../src/phone-verification/phone-otp';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker, getQueue } from '../helpers/worker.helper';
import { JobQueue } from '../../src/jobs/job-queues';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { resetDb, seedMinimal, setStock } from '../helpers/db.helper';

interface GqlError {
  message: string;
  extensions: Record<string, unknown> & { code: string; reason?: string };
}
interface GqlResult {
  data?: Record<string, any>;
  errors?: GqlError[];
}

const PHONE = '+233244555111';
const NEW_PHONE = '+233244555222';

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(50);
  }
}

describe('SMS phone verification and cash-on-delivery risk gates (P3-B.1, P3-B.2, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let redis: Redis;
  let userToken: string;
  let managerToken: string;
  let ownerToken: string;
  let addressId: string;

  const sms = {
    send: jest.fn<Promise<{ messageId: string }>, [string, string]>(async () => ({ messageId: 'fake-msg' })),
  };
  const logged: string[] = [];

  const gql = async (query: string, token = userToken, variables?: Record<string, unknown>): Promise<GqlResult> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const errorOf = (result: GqlResult) => result.errors?.[0] && { ...result.errors[0].extensions };

  const setPhone = (phoneNumber: string) =>
    gql('mutation ($input: UpdateUserInput!) { updateMyProfile(updateMyProfileInput: $input) { id } }', userToken, {
      input: { phoneNumber },
    });
  const requestCode = () =>
    gql('mutation { requestPhoneVerification { phoneLast3 expiresInSeconds resendAfterSeconds } }');
  const verify = (code: string) =>
    gql(`mutation { verifyPhone(input: { code: "${code}" }) { phoneVerified phoneVerifiedAt } }`);
  const verificationStatus = async () =>
    (await gql('{ myPhoneVerification { phoneVerified phoneVerifiedAt } }')).data!.myPhoneVerification;
  const allowResend = async (phone: string) => redis.del(otpKeys('seed_user', phone).cooldown);

  /** Requests a code and returns it as the SMS fake received it from the worker. */
  const receiveCode = async (phone: string): Promise<string> => {
    const before = sms.send.mock.calls.length;
    const res = await requestCode();
    expect(res.errors).toBeUndefined();
    await waitUntil(() => sms.send.mock.calls.length > before);
    const [to, text] = sms.send.mock.calls[before];
    expect(to).toBe(phone);
    expect(text.length).toBeLessThanOrEqual(160);
    return /^(\d{6}) /.exec(text)![1];
  };

  const fillCart = () => gql('mutation { addToCart(input: { variantId: "seed_var2", quantity: 1 }) { id } }');
  const delivery = () => `fulfillmentType: DELIVERY, shippingAddressId: "${addressId}"`;
  const pickup = 'fulfillmentType: PICKUP, pickupLocationId: "cod_pickup"';
  const quote = async (place = delivery(), paymentMethod = 'CASH_ON_DELIVERY') =>
    gql(
      `{ checkoutQuote(input: { ${place}, paymentMethod: ${paymentMethod} }) {
        quoteHash grandTotal { amount } cashOnDelivery { available reason phoneVerified } } }`,
    );
  /** Fills the cart, quotes and places the order; the cart is emptied whether or not it is placed. */
  const placeOrder = async (paymentMethod: string, place = delivery()): Promise<GqlResult> => {
    await fillCart();
    const quoted = await quote(place, paymentMethod);
    expect(quoted.errors).toBeUndefined();
    const res = await gql(
      `mutation { createOrder(input: { ${place}, paymentMethod: ${paymentMethod}, quoteHash: "${quoted.data!.checkoutQuote.quoteHash}",
        contactEmail: "user@example.com", contactPhone: "${PHONE}" }) { id status } }`,
    );
    await prisma.cartItem.deleteMany({ where: { cart: { userId: 'seed_user' } } });
    return res;
  };
  const codRefusalOf = async (place = delivery()) => {
    const res = await placeOrder('CASH_ON_DELIVERY', place);
    return errorOf(res);
  };
  const expectOnlineStillWorks = async () => {
    const res = await placeOrder('ONLINE');
    expect(res.errors).toBeUndefined();
    expect(res.data!.createOrder.status).toBe('PLACED');
  };
  const setLimits = (data: { codMaxOpenOrdersPerPhone?: number; codMaxOrderTotal?: number }) =>
    prisma.store.updateMany({ data });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    worker = await createTestWorker((builder) => builder.overrideProvider(SMS_PROVIDER).useValue(sms));
    redis = app.get(REDIS_CLIENT);
    for (const context of [app.get(LoggerService), worker.get(LoggerService)]) {
      for (const level of ['log', 'warn', 'error', 'debug'] as const) {
        const original = context[level].bind(context) as (...args: unknown[]) => void;
        jest.spyOn(context, level).mockImplementation((...args: unknown[]) => {
          logged.push(JSON.stringify(args));
          original(...args);
        });
      }
    }
    await clearQueues(worker);
    const otpKeysLeft = await redis.keys('otp:*');
    if (otpKeysLeft.length > 0) await redis.del(...otpKeysLeft);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await setStock(prisma, 'seed_var2', 1000);
    await prisma.pickupLocation.create({
      data: {
        id: 'cod_pickup',
        name: 'Osu Store',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
    const address = await prisma.address.create({
      data: {
        userId: 'seed_user',
        recipientName: 'Ama Mensah',
        phone: '+233244555999',
        region: 'GREATER_ACCRA',
        street: '12 Oxford St.',
        city: 'Accra',
        ghanaPostGps: 'GA-183-8164',
        country: 'GH',
      },
    });
    addressId = address.id;
    userToken = await signInUser(app);
    managerToken = await signInAdmin(app);
    ownerToken = await signInSuperAdmin(app);
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  describe('phone verification by SMS code', () => {
    let code: string;

    it('needs a phone number on the profile', async () => {
      expect(errorOf(await requestCode())).toMatchObject({ code: 'BAD_REQUEST', reason: 'PHONE_REQUIRED' });
    });

    it('refuses cash on delivery until the phone is verified, while online payment works', async () => {
      expect((await setPhone(PHONE)).errors).toBeUndefined();
      await fillCart();
      const quoted = await quote();
      await prisma.cartItem.deleteMany({ where: { cart: { userId: 'seed_user' } } });

      expect(quoted.data!.checkoutQuote.cashOnDelivery).toEqual({
        available: false,
        reason: 'PHONE_NOT_VERIFIED',
        phoneVerified: false,
      });
      expect(await codRefusalOf()).toMatchObject({ code: 'BAD_REQUEST', reason: 'PHONE_NOT_VERIFIED' });
      await expectOnlineStillWorks();
    });

    it('texts a 6-digit code from the worker; the job leaves Redis once sent', async () => {
      code = await receiveCode(PHONE);

      expect(code).toMatch(/^\d{6}$/);
      const queue = getQueue(worker, JobQueue.NOTIFICATIONS);
      // Other jobs (the online order's events) stay; the SMS job, holding the code and number, must not.
      await waitUntil(async () => {
        const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed']);
        return !jobs.some((job) => job.name === 'sms.phone_otp.v1');
      });
    });

    it('refuses another code within the 60-second cooldown', async () => {
      const res = await requestCode();
      expect(errorOf(res)).toMatchObject({ code: 'BAD_REQUEST', reason: 'OTP_RATE_LIMITED', limit: 'COOLDOWN' });
      expect(errorOf(res)!.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts a wrong code against the attempts', async () => {
      const wrong = code === '000000' ? '111111' : '000000';
      expect(errorOf(await verify(wrong))).toMatchObject({
        code: 'BAD_REQUEST',
        reason: 'OTP_INVALID',
        attemptsRemaining: 4,
      });
    });

    it('verifies the phone with the right code, once', async () => {
      const res = await verify(code);

      expect(res.errors).toBeUndefined();
      expect(res.data!.verifyPhone.phoneVerified).toBe(true);
      expect(await verificationStatus()).toMatchObject({ phoneVerified: true });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: 'seed_user' } })).toMatchObject({
        phoneVerifiedNumber: PHONE,
        phoneVerifiedAt: expect.any(Date),
      });
      expect(errorOf(await requestCode())).toMatchObject({ reason: 'PHONE_ALREADY_VERIFIED' });
    });

    it('places a cash-on-delivery order once verified, recording the verified phone on it', async () => {
      await fillCart();
      const quoted = await quote();
      await prisma.cartItem.deleteMany({ where: { cart: { userId: 'seed_user' } } });
      expect(quoted.data!.checkoutQuote.cashOnDelivery).toEqual({ available: true, reason: null, phoneVerified: true });

      const res = await placeOrder('CASH_ON_DELIVERY');

      expect(res.errors).toBeUndefined();
      expect(res.data!.createOrder.status).toBe('CONFIRMED');
      const order = await prisma.order.findUniqueOrThrow({ where: { id: res.data!.createOrder.id } });
      expect(order.codPhone).toBe(PHONE);
    });

    it('needs the new phone verified again after a change', async () => {
      expect((await setPhone(NEW_PHONE)).errors).toBeUndefined();

      expect(await verificationStatus()).toEqual({ phoneVerified: false, phoneVerifiedAt: null });
      expect(await prisma.user.findUniqueOrThrow({ where: { id: 'seed_user' } })).toMatchObject({
        phoneVerifiedAt: null,
        phoneVerifiedNumber: null,
      });
      expect(await codRefusalOf()).toMatchObject({ reason: 'PHONE_NOT_VERIFIED' });
    });

    it('kills a code after 5 wrong entries', async () => {
      const fresh = await receiveCode(NEW_PHONE);
      const wrong = fresh === '000000' ? '111111' : '000000';
      for (const remaining of [4, 3, 2, 1]) {
        expect(errorOf(await verify(wrong))).toMatchObject({ reason: 'OTP_INVALID', attemptsRemaining: remaining });
      }
      expect(errorOf(await verify(wrong))).toMatchObject({ reason: 'OTP_ATTEMPTS_EXCEEDED' });
      expect(errorOf(await verify(fresh))).toMatchObject({ reason: 'OTP_EXPIRED' });
    });

    it('refuses an expired code', async () => {
      await allowResend(NEW_PHONE);
      const fresh = await receiveCode(NEW_PHONE);
      await redis.pexpire(otpKeys('seed_user', NEW_PHONE).code, 1);
      await sleep(20);

      expect(errorOf(await verify(fresh))).toMatchObject({ reason: 'OTP_EXPIRED' });
    });

    it('caps the codes sent to one number a day', async () => {
      await allowResend(NEW_PHONE);
      await redis.set(otpKeys('seed_user', NEW_PHONE).phoneDaily, 5, 'EX', 3600);

      const res = await requestCode();

      expect(errorOf(res)).toMatchObject({ reason: 'OTP_RATE_LIMITED', limit: 'PHONE_DAILY' });
      await redis.del(otpKeys('seed_user', NEW_PHONE).phoneDaily);
    });

    it('verifies the new phone', async () => {
      await allowResend(NEW_PHONE);
      const fresh = await receiveCode(NEW_PHONE);
      expect((await verify(fresh)).data!.verifyPhone.phoneVerified).toBe(true);
    });

    it('never logged a code or a full phone number', async () => {
      const codes = sms.send.mock.calls.map(([, text]) => /^(\d{6}) /.exec(text)![1]);
      const all = logged.join('\n');
      for (const sent of codes) expect(all).not.toContain(`${sent} is your`);
      for (const sent of codes) expect(all).not.toMatch(new RegExp(`\\b${sent}\\b`));
      expect(all).not.toContain('244555111');
      expect(all).not.toContain('244555222');
    });
  });

  describe('risk gates (the phone is verified)', () => {
    let refusals: jest.SpyInstance;

    beforeAll(() => {
      refusals = jest.spyOn(app.get(AppMetrics), 'recordCodGateRefusal');
    });

    afterEach(async () => {
      await setLimits({ codMaxOpenOrdersPerPhone: 100, codMaxOrderTotal: 999_999_999 });
      await prisma.shippingZone.updateMany({ data: { codEnabled: true } });
      await prisma.codBlacklistEntry.deleteMany();
    });

    it('caps the open cash-on-delivery orders of the verified phone', async () => {
      // The NEW_PHONE account holds one open COD order, placed under PHONE: the account's own orders count too.
      await setLimits({ codMaxOpenOrdersPerPhone: 1 });
      await fillCart();
      const quoted = await quote();
      await prisma.cartItem.deleteMany({ where: { cart: { userId: 'seed_user' } } });

      expect(quoted.data!.checkoutQuote.cashOnDelivery).toMatchObject({ available: false, reason: 'OPEN_ORDER_LIMIT' });
      expect(await codRefusalOf()).toMatchObject({
        code: 'BAD_REQUEST',
        reason: 'COD_NOT_AVAILABLE',
        codReason: 'OPEN_ORDER_LIMIT',
      });
      expect(refusals).toHaveBeenLastCalledWith('OPEN_ORDER_LIMIT');
      await expectOnlineStillWorks();

      await setLimits({ codMaxOpenOrdersPerPhone: 2 });
      expect((await placeOrder('CASH_ON_DELIVERY')).errors).toBeUndefined();
    });

    it('does not count completed or cancelled orders as open', async () => {
      await prisma.order.updateMany({
        where: { userId: 'seed_user', paymentMethod: 'CASH_ON_DELIVERY' },
        data: { status: 'CANCELLED' },
      });
      await setLimits({ codMaxOpenOrdersPerPhone: 1 });

      expect((await placeOrder('CASH_ON_DELIVERY')).errors).toBeUndefined();
    });

    it('caps the grand total paid on delivery', async () => {
      await setLimits({ codMaxOrderTotal: 100 });

      expect(await codRefusalOf()).toMatchObject({ reason: 'COD_NOT_AVAILABLE', codReason: 'ORDER_TOTAL_ABOVE_CAP' });
      expect(refusals).toHaveBeenLastCalledWith('ORDER_TOTAL_ABOVE_CAP');
      await expectOnlineStillWorks();
    });

    it('refuses delivery zones not marked for cash on delivery, not pickup', async () => {
      const res = await gql(
        'mutation { setShippingZoneCashOnDelivery(id: "seed_zone_accra", enabled: false) { id codEnabled } }',
        ownerToken,
      );
      expect(res.data!.setShippingZoneCashOnDelivery).toEqual({ id: 'seed_zone_accra', codEnabled: false });

      expect(await codRefusalOf()).toMatchObject({ reason: 'COD_NOT_AVAILABLE', codReason: 'SHIPPING_ZONE_EXCLUDED' });
      await expectOnlineStillWorks();
      expect((await placeOrder('CASH_ON_DELIVERY', pickup)).errors).toBeUndefined();
      expect(
        await prisma.auditLog.findFirst({ where: { entity: 'ShippingZone', entityId: 'seed_zone_accra' } }),
      ).toMatchObject({ action: 'UPDATE', details: { changes: { codEnabled: { from: true, to: false } } } });
    });

    it.each([
      ['the delivery street, in another spelling', { street: '12, OXFORD ST', city: 'accra' }],
      ['the GhanaPost GPS code', { ghanaPostGps: 'ga 183 8164' }],
      ['the account phone', { phone: '024 455 5222' }],
      ['the address phone', { phone: '+233244555999' }],
    ])('refuses a blacklisted %s', async (_case, target) => {
      const added = await gql(
        'mutation ($input: AddCodBlacklistEntryInput!) { addCodBlacklistEntry(input: $input) { id kind value } }',
        ownerToken,
        { input: { ...target, reason: 'Refused deliveries' } },
      );
      expect(added.errors).toBeUndefined();

      expect(await codRefusalOf()).toMatchObject({ reason: 'COD_NOT_AVAILABLE', codReason: 'BLOCKED' });
      await expectOnlineStillWorks();

      const removed = await gql(
        `mutation { removeCodBlacklistEntry(id: "${added.data!.addCodBlacklistEntry.id}") { id } }`,
        ownerToken,
      );
      expect(removed.errors).toBeUndefined();
      expect((await placeOrder('CASH_ON_DELIVERY')).errors).toBeUndefined();
    });
  });

  describe('settings and blacklist management', () => {
    const operations = [
      '{ codRiskSettings { maxOpenOrdersPerPhone maxOrderTotal { amount } } }',
      'mutation { updateCodRiskSettings(input: { maxOpenOrdersPerPhone: 3 }) { maxOpenOrdersPerPhone } }',
      'mutation { setShippingZoneCashOnDelivery(id: "seed_zone_accra", enabled: false) { id } }',
      '{ codBlacklist { id } }',
      'mutation { addCodBlacklistEntry(input: { phone: "0244000001", reason: "x" }) { id } }',
      'mutation { removeCodBlacklistEntry(id: "none") { id } }',
    ];

    it.each([
      ['a Manager', () => managerToken],
      ['a customer', () => userToken],
    ])('refuses %s every operation with FORBIDDEN', async (_who, token) => {
      for (const operation of operations) expect(errorOf(await gql(operation, token()))?.code).toBe('FORBIDDEN');
    });

    it('needs a recent step-up for every change, not for the reads', async () => {
      const keys = await redis.keys('mfa:step-up:*');
      if (keys.length > 0) await redis.del(...keys);

      const [settings, update, zone, list, add, remove] = await Promise.all(
        operations.map((operation) => gql(operation, ownerToken)),
      );
      for (const change of [update, zone, add, remove]) expect(errorOf(change)?.reason).toBe('STEP_UP_REQUIRED');
      for (const read of [settings, list]) expect(read.errors).toBeUndefined();
      expect(await prisma.codBlacklistEntry.count()).toBe(0);
      ownerToken = await signInSuperAdmin(app);
    });

    it('shows and updates the limits, validated and audited', async () => {
      expect(errorOf(await gql(operations[1].replace('3', '0'), ownerToken))?.code).toBe('BAD_USER_INPUT');
      expect(
        errorOf(
          await gql(
            'mutation { updateCodRiskSettings(input: { maxOrderTotal: "0" }) { maxOpenOrdersPerPhone } }',
            ownerToken,
          ),
        )?.code,
      ).toBe('BAD_USER_INPUT');

      const res = await gql(
        'mutation { updateCodRiskSettings(input: { maxOpenOrdersPerPhone: 3, maxOrderTotal: "1500.50" }) { maxOpenOrdersPerPhone maxOrderTotal { amount } } }',
        ownerToken,
      );

      expect(res.data!.updateCodRiskSettings).toEqual({
        maxOpenOrdersPerPhone: 3,
        maxOrderTotal: { amount: '1500.50' },
      });
      expect((await gql(operations[0], ownerToken)).data!.codRiskSettings.maxOpenOrdersPerPhone).toBe(3);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entity: 'Store', action: 'UPDATE' },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.details).toMatchObject({
        codRiskSettings: { maxOpenOrdersPerPhone: { from: 100, to: 3 }, maxOrderTotal: { to: '1500.5' } },
      });
    });

    it('stores blacklist entries normalised with their author, refuses duplicates and audits both changes', async () => {
      const add = (input: Record<string, string>) =>
        gql(
          'mutation ($input: AddCodBlacklistEntryInput!) { addCodBlacklistEntry(input: $input) { id kind value reason createdById } }',
          ownerToken,
          { input },
        );

      const added = await add({ phone: '024 400 0001', reason: 'Fake orders' });
      const owner = await prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } });
      expect(added.data!.addCodBlacklistEntry).toMatchObject({
        kind: 'PHONE',
        value: '+233244000001',
        reason: 'Fake orders',
        createdById: owner.id,
      });
      expect(errorOf(await add({ phone: '+233244000001', reason: 'Again' }))?.code).toBe('CONFLICT');
      expect(errorOf(await add({ phone: '0244000002', ghanaPostGps: 'GA1', reason: 'Both' }))?.code).toBe(
        'BAD_REQUEST',
      );
      expect((await gql('{ codBlacklist { value } }', ownerToken)).data!.codBlacklist).toEqual([
        { value: '+233244000001' },
      ]);

      const id = added.data!.addCodBlacklistEntry.id;
      expect(
        (await gql(`mutation { removeCodBlacklistEntry(id: "${id}") { id } }`, ownerToken)).errors,
      ).toBeUndefined();
      expect(errorOf(await gql(`mutation { removeCodBlacklistEntry(id: "${id}") { id } }`, ownerToken))?.code).toBe(
        'NOT_FOUND',
      );
      const audits = await prisma.auditLog.findMany({ where: { entity: 'CodBlacklistEntry', entityId: id } });
      expect(audits.map((audit) => audit.action).sort()).toEqual(['CREATE', 'DELETE']);
    });
  });
});
