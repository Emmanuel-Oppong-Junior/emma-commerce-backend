import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { PaystackClient } from '../../src/payment/paystack.client';
import { SMS_PROVIDER } from '../../src/notifications/sms/sms-provider.port';
import { EmailService } from '../../src/notifications/email/email.service';
import { otpKeys } from '../../src/phone-verification/phone-otp';
import { guestOtpSubject } from '../../src/guest-checkout/guest-cart-token';
import { createTestApp } from '../helpers/app.helper';
import { clearQueues, createTestWorker } from '../helpers/worker.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInUser } from '../helpers/auth.helper';
import { relaxVelocityLimits, resetDb, seedMinimal, setStock } from '../helpers/db.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: Record<string, unknown> & { code: string; reason?: string } }[];
}

const ADDRESS = `{ recipientName: "Kofi Guest", phone: "0244777000", region: GREATER_ACCRA, street: "4 Ring Rd", city: "Accra" }`;
const DELIVERY = `fulfillmentType: DELIVERY, shippingAddress: ${ADDRESS}`;
const ORDER_FIELDS = `id orderNumber status contactName contactEmail contactPhone paymentStatus
  grandTotal { amount } trackingTimeline { orderStatus }`;

async function waitUntil(condition: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await sleep(50);
  }
}

describe('Guest checkout with phone verification (P6-G.1, e2e)', () => {
  let app: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaService;
  let redis: Redis;

  const sms = {
    send: jest.fn<Promise<{ messageId: string }>, [string, string]>(async () => ({ messageId: 'fake-msg' })),
  };
  const emailSend = jest.fn(async () => ({ messageId: 'fake-email' }));
  const paystack = {
    initializeTransaction: jest.fn(async ({ reference }: { reference: string }) => ({
      reference,
      authorization_url: `https://checkout.test/${reference}`,
      access_code: `ac-${reference}`,
    })),
    verifyTransaction: jest.fn(async (reference: string) => {
      const attempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { reference } });
      return { reference, status: 'success', amount: attempt.amount.mul(100).toNumber(), currency: 'GHS' };
    }),
  };

  const gql = async (query: string, variables?: Record<string, unknown>, token?: string): Promise<GqlResult> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const errorOf = (result: GqlResult) => result.errors?.[0]?.extensions;

  const createCart = async (): Promise<{ token: string; cartId: string }> => {
    const res = await gql('mutation { createGuestCart { guestCartToken cart { id phoneVerified expiresAt } } }');
    expect(res.errors).toBeUndefined();
    const { guestCartToken, cart } = res.data!.createGuestCart;
    return { token: guestCartToken, cartId: cart.id };
  };
  const addItem = (token: string, quantity = 1) =>
    gql(
      `mutation ($t: String!) { addToGuestCart(guestCartToken: $t, input: { variantId: "seed_var2", quantity: ${quantity} }) {
        items { variantId quantity } } }`,
      { t: token },
    );
  const requestCode = (token: string, phone: string) =>
    gql(
      `mutation ($t: String!, $p: String!) { requestGuestPhoneVerification(guestCartToken: $t, input: { phone: $p }) {
        phoneLast3 } }`,
      { t: token, p: phone },
    );
  const verifyCode = (token: string, code: string) =>
    gql(
      `mutation ($t: String!, $c: String!) { verifyGuestPhone(guestCartToken: $t, input: { code: $c }) {
        phoneVerified phoneLast3 } }`,
      { t: token, c: code },
    );
  /** Requests a code for the guest cart and returns it as the SMS fake received it from the worker. */
  const receiveCode = async (send: () => Promise<GqlResult>, phone: string): Promise<string> => {
    const before = sms.send.mock.calls.length;
    const res = await send();
    expect(res.errors).toBeUndefined();
    await waitUntil(() => sms.send.mock.calls.slice(before).some(([to]) => to === phone));
    const [, text] = sms.send.mock.calls.slice(before).find(([to]) => to === phone)!;
    return /^(\d{6}) /.exec(text)![1];
  };
  const quote = (token: string, place = DELIVERY, paymentMethod = 'ONLINE') =>
    gql(
      `query ($t: String!) { guestCheckoutQuote(guestCartToken: $t, input: { ${place}, paymentMethod: ${paymentMethod} }) {
        quoteHash grandTotal { amount } cashOnDelivery { available reason phoneVerified } } }`,
      { t: token },
    );
  const createOrder = (token: string, quoteHash: string, extra = '', paymentMethod = 'ONLINE') =>
    gql(
      `mutation ($t: String!, $h: String!) { createGuestOrder(guestCartToken: $t, input: {
        ${DELIVERY}, paymentMethod: ${paymentMethod}, contactName: "Kofi Guest", quoteHash: $h ${extra} }) {
        orderAccessToken order { ${ORDER_FIELDS} } } }`,
      { t: token, h: quoteHash },
    );
  const guestOrder = (orderAccessToken: string) =>
    gql(`query ($a: String!) { guestOrder(orderAccessToken: $a) { ${ORDER_FIELDS} } }`, { a: orderAccessToken });

  /** A verified guest cart with one item, ordered: returns the order and its access token. */
  const placeGuestOrder = async (phone: string, extra = '') => {
    const { token } = await createCart();
    expect((await addItem(token)).errors).toBeUndefined();
    const code = await receiveCode(() => requestCode(token, phone), phone);
    expect((await verifyCode(token, code)).errors).toBeUndefined();
    const quoted = await quote(token);
    expect(quoted.errors).toBeUndefined();
    const placed = await createOrder(token, quoted.data!.guestCheckoutQuote.quoteHash, extra);
    expect(placed.errors).toBeUndefined();
    return placed.data!.createGuestOrder as { orderAccessToken: string; order: { id: string; orderNumber: number } };
  };

  const initializePayment = (orderAccessToken: string) =>
    request(app.getHttpServer())
      .post('/payment/guest/initialize')
      .send({
        orderAccessToken,
        paymentMethod: 'MOBILE_MONEY',
        idempotencyKey: `key-${orderAccessToken.slice(0, 12)}`,
      });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    worker = await createTestWorker((builder) => builder.overrideProvider(SMS_PROVIDER).useValue(sms));
    jest.spyOn(worker.get(EmailService), 'send').mockImplementation(emailSend);
    redis = app.get(REDIS_CLIENT);
    await clearQueues(worker);
    for (const pattern of ['otp:*', 'velocity:*']) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) await redis.del(...keys);
    }
    await resetDb(prisma);
    await seedMinimal(prisma);
    await setStock(prisma, 'seed_var2', 1000);
    await prisma.pickupLocation.create({
      data: {
        id: 'guest_pickup',
        name: 'Osu Store',
        address: '1 Oxford St',
        city: 'Accra',
        region: 'GREATER_ACCRA',
        country: 'GH',
      },
    });
  });

  afterAll(async () => {
    await clearQueues(worker);
    await resetDb(prisma);
    await worker.close();
    await app.close();
  });

  describe('the guest journey', () => {
    const PHONE = '+233244777001';
    let token: string;
    let orderAccessToken: string;
    let orderId: string;
    let reference: string;

    it('starts a cart without an account and adds to it with the token', async () => {
      ({ token } = await createCart());
      const added = await addItem(token, 2);

      expect(added.errors).toBeUndefined();
      expect(added.data!.addToGuestCart.items).toEqual([{ variantId: 'seed_var2', quantity: 2 }]);
      expect(
        (await gql('query ($t: String!) { guestCart(guestCartToken: $t) { items { quantity } } }', { t: token })).data,
      ).toEqual({ guestCart: { items: [{ quantity: 2 }] } });
    });

    it('quotes like a customer, but cash on delivery is not for guests', async () => {
      const quoted = await quote(token);

      expect(quoted.errors).toBeUndefined();
      expect(quoted.data!.guestCheckoutQuote.grandTotal.amount).toBe('1014.98');
      expect(quoted.data!.guestCheckoutQuote.cashOnDelivery).toEqual({
        available: false,
        reason: 'GUEST_CHECKOUT',
        phoneVerified: false,
      });
      expect(errorOf(await quote(token, DELIVERY, 'CASH_ON_DELIVERY'))).toMatchObject({
        code: 'BAD_REQUEST',
        reason: 'COD_NOT_AVAILABLE',
        codReason: 'GUEST_CHECKOUT',
      });
    });

    it('refuses the order while the phone is not verified', async () => {
      const quoteHash = (await quote(token)).data!.guestCheckoutQuote.quoteHash;
      expect(errorOf(await createOrder(token, quoteHash))).toMatchObject({
        code: 'BAD_REQUEST',
        reason: 'GUEST_PHONE_NOT_VERIFIED',
      });
      await receiveCode(() => requestCode(token, PHONE), PHONE);
      expect(errorOf(await createOrder(token, quoteHash))).toMatchObject({ reason: 'GUEST_PHONE_NOT_VERIFIED' });
      expect(await prisma.order.count()).toBe(0);
    });

    it('verifies the phone with the texted code, refusing a wrong one', async () => {
      await redis.del(otpKeys(guestOtpSubject((await cartIdOf(token))!), PHONE).cooldown);
      const code = await receiveCode(() => requestCode(token, PHONE), PHONE);
      const wrong = code === '000000' ? '111111' : '000000';

      expect(errorOf(await verifyCode(token, wrong))).toMatchObject({ reason: 'OTP_INVALID', attemptsRemaining: 4 });
      const verified = await verifyCode(token, code);
      expect(verified.errors).toBeUndefined();
      expect(verified.data!.verifyGuestPhone).toEqual({ phoneVerified: true, phoneLast3: '001' });
      // The code is used up.
      expect(errorOf(await verifyCode(token, code))).toMatchObject({ reason: 'OTP_EXPIRED' });
    });

    it('refuses cash on delivery for the order too', async () => {
      const quoteHash = (await quote(token)).data!.guestCheckoutQuote.quoteHash;
      expect(errorOf(await createOrder(token, quoteHash, '', 'CASH_ON_DELIVERY'))).toMatchObject({
        reason: 'COD_NOT_AVAILABLE',
        codReason: 'GUEST_CHECKOUT',
      });
    });

    it('places the order without an account, under the verified phone, and empties the cart', async () => {
      const quoteHash = (await quote(token)).data!.guestCheckoutQuote.quoteHash;
      const placed = await createOrder(token, quoteHash, ', contactEmail: "kofi.guest@example.com"');

      expect(placed.errors).toBeUndefined();
      ({ orderAccessToken } = placed.data!.createGuestOrder);
      const { order } = placed.data!.createGuestOrder;
      orderId = order.id;
      expect(order).toMatchObject({
        status: 'PLACED',
        contactName: 'Kofi Guest',
        contactEmail: 'kofi.guest@example.com',
        contactPhone: PHONE,
        paymentStatus: null,
        grandTotal: { amount: '1014.98' },
      });
      const stored = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(stored).toMatchObject({ userId: null, guestPhone: PHONE, paymentMethod: 'ONLINE' });
      expect(stored.guestPhoneVerifiedAt).not.toBeNull();
      expect(
        (await gql('query ($t: String!) { guestCart(guestCartToken: $t) { items { id } } }', { t: token })).data,
      ).toEqual({ guestCart: { items: [] } });
    });

    it('shows the order and its tracking to the holder of the access token', async () => {
      const res = await guestOrder(orderAccessToken);

      expect(res.errors).toBeUndefined();
      expect(res.data!.guestOrder).toMatchObject({
        id: orderId,
        status: 'PLACED',
        trackingTimeline: [{ orderStatus: 'PLACED' }],
      });
    });

    it('pays online through the provider with the access token', async () => {
      const res = await initializePayment(orderAccessToken).expect(201);

      expect(res.body.authorizationUrl).toMatch(/^https:\/\/checkout\.test\//);
      reference = res.body.transactionId;
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ email: 'kofi.guest@example.com', amount: 101498 }),
      );

      const verified = await gql(
        `mutation ($a: String!, $r: String!) { verifyGuestPayment(orderAccessToken: $a, reference: $r) { status paymentStatus } }`,
        { a: orderAccessToken, r: reference },
      );
      expect(verified.errors).toBeUndefined();
      expect(verified.data!.verifyGuestPayment).toEqual({ status: 'CONFIRMED', paymentStatus: 'CAPTURED' });
      expect((await guestOrder(orderAccessToken)).data!.guestOrder.trackingTimeline).toEqual([
        { orderStatus: 'PLACED' },
        { orderStatus: 'CONFIRMED' },
      ]);
    });

    it('texts and emails the guest once each: the order with its link, then the payment', async () => {
      const rowsFor = (template: string) =>
        prisma.notification.findMany({ where: { refType: 'Order', refId: orderId, templateKey: template } });
      await waitUntil(
        async () => (await rowsFor('payment.received')).filter((row) => row.status === 'SENT').length === 2,
      );
      await waitUntil(
        async () => (await rowsFor('order.guest_placed')).filter((row) => row.status === 'SENT').length === 2,
      );

      for (const template of ['order.guest_placed', 'payment.received']) {
        const rows = await rowsFor(template);
        expect(rows.map((row) => row.channel).sort()).toEqual(['EMAIL', 'SMS']);
        expect(rows.every((row) => row.userId === null)).toBe(true);
      }
      const texts = sms.send.mock.calls.filter(([to]) => to === PHONE).map(([, text]) => text);
      const placedTexts = texts.filter((text) => text.includes('placed'));
      expect(placedTexts).toHaveLength(1);
      expect(placedTexts[0]).toContain(`/guest-order#token=${encodeURIComponent(orderAccessToken)}`);
      expect(texts.filter((text) => text.startsWith('We received your payment'))).toHaveLength(1);
      const emails = emailSend.mock.calls as unknown as [string, { subject: string }][];
      expect(emails.filter(([to]) => to === 'kofi.guest@example.com')).toHaveLength(2);
      expect(await prisma.notification.count({ where: { refId: orderId, channel: 'IN_APP' } })).toBe(0);
    });

    it("refuses another order's access token, a forged one and a reference of another order", async () => {
      const other = await placeGuestOrder('+233244777002');
      const [, signature] = other.orderAccessToken.split('.');
      const forged = `${orderId}.${signature}`;

      expect(errorOf(await guestOrder(forged))).toMatchObject({ code: 'NOT_FOUND' });
      expect(errorOf(await guestOrder('not-a-token'))).toMatchObject({ code: 'NOT_FOUND' });
      await initializePayment(forged).expect(404);
      const res = await gql(
        `mutation ($a: String!, $r: String!) { verifyGuestPayment(orderAccessToken: $a, reference: $r) { status } }`,
        { a: other.orderAccessToken, r: reference },
      );
      expect(errorOf(res)).toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('codes and tokens', () => {
    it('refuses an expired code', async () => {
      const phone = '+233244777003';
      const { token, cartId } = await createCart();
      const code = await receiveCode(() => requestCode(token, phone), phone);
      await redis.del(otpKeys(guestOtpSubject(cartId), phone).code);

      expect(errorOf(await verifyCode(token, code))).toMatchObject({ code: 'BAD_REQUEST', reason: 'OTP_EXPIRED' });
    });

    it('binds a code to its cart: another cart cannot use it', async () => {
      const phone = '+233244777004';
      const first = await createCart();
      const second = await createCart();
      const code = await receiveCode(() => requestCode(first.token, phone), phone);
      await receiveCode(() => requestCode(second.token, phone), phone);

      // The second cart's own code is different (or, by chance, equal and then it simply verifies its own).
      const res = await verifyCode(second.token, code);
      if (res.errors) expect(errorOf(res)).toMatchObject({ reason: 'OTP_INVALID' });
      expect((await verifyCode(first.token, code)).data!.verifyGuestPhone.phoneVerified).toBe(true);
    });

    it('refuses an unknown or expired guest cart token', async () => {
      const { token, cartId } = await createCart();
      await prisma.cart.update({ where: { id: cartId }, data: { guestExpiresAt: new Date(Date.now() - 1000) } });

      expect(errorOf(await addItem(token))).toMatchObject({ code: 'NOT_FOUND' });
      expect(errorOf(await addItem(`gct_${'A'.repeat(43)}`))).toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  it('refuses a guest above the order limit per phone', async () => {
    const phone = '+233244777005';
    const store = await prisma.store.findFirstOrThrow({ where: { singleton: true } });
    await prisma.velocityLimit.updateMany({
      where: { storeId: store.id, rule: 'ORDERS_PER_PHONE_24H' },
      data: { softLimit: 1, hardLimit: 1 },
    });
    try {
      await placeGuestOrder(phone);
      const { token } = await createCart();
      await addItem(token);
      const code = await receiveCode(() => requestCode(token, phone), phone);
      await verifyCode(token, code);
      const quoteHash = (await quote(token)).data!.guestCheckoutQuote.quoteHash;
      expect(errorOf(await createOrder(token, quoteHash))).toMatchObject({
        code: 'FORBIDDEN',
        reason: 'VELOCITY_LIMIT',
      });
    } finally {
      await relaxVelocityLimits(prisma);
    }
  });

  describe('attaching guest orders to an account', () => {
    const SIGN_UP_PHONE = '+233244777006';
    const ACCOUNT_PHONE = '+233244777007';
    const OTHER_PHONE = '+233244777008';

    const myOrderIds = async (token: string) =>
      ((await gql('{ userOrders { id } }', undefined, token)).data!.userOrders as { id: string }[]).map((o) => o.id);

    it('attaches the guest orders of the phone at sign-up with a guest order token, and only those', async () => {
      const first = await placeGuestOrder(SIGN_UP_PHONE);
      const second = await placeGuestOrder(SIGN_UP_PHONE);
      const unrelated = await placeGuestOrder(OTHER_PHONE);

      const signUp = await gql(`mutation ($input: SignUpInput!) { signUp(input: $input) { accessToken } }`, {
        input: {
          name: 'Kofi Guest',
          email: 'kofi.signup@example.com',
          password: 'GuestBuyer@123',
          guestOrderToken: first.orderAccessToken,
        },
      });
      expect(signUp.errors).toBeUndefined();
      const account = await prisma.user.findUniqueOrThrow({ where: { email: 'kofi.signup@example.com' } });
      expect(account).toMatchObject({ phoneNumber: SIGN_UP_PHONE, phoneVerifiedNumber: SIGN_UP_PHONE });
      expect(account.phoneVerifiedAt).not.toBeNull();

      expect((await myOrderIds(signUp.data!.signUp.accessToken)).sort()).toEqual(
        [first.order.id, second.order.id].sort(),
      );
      expect((await prisma.order.findUniqueOrThrow({ where: { id: unrelated.order.id } })).userId).toBeNull();
      expect(
        await prisma.notification.count({ where: { refType: 'Order', refId: first.order.id, userId: null } }),
      ).toBe(0);
    });

    it('refuses a second sign-up claiming a phone an account holds', async () => {
      const again = await placeGuestOrder(OTHER_PHONE);
      await prisma.user.create({ data: { email: 'holder@example.com', phoneNumber: OTHER_PHONE } });

      const res = await gql(`mutation ($input: SignUpInput!) { signUp(input: $input) { accessToken } }`, {
        input: {
          name: 'Someone',
          email: 'someone@example.com',
          password: 'GuestBuyer@123',
          guestOrderToken: again.orderAccessToken,
        },
      });
      expect(errorOf(res)).toMatchObject({ code: 'CONFLICT', reason: 'PHONE_IN_USE' });
      expect(await prisma.user.count({ where: { email: 'someone@example.com' } })).toBe(0);
      await prisma.user.delete({ where: { email: 'holder@example.com' } });
    });

    it('attaches them when an existing account verifies the same phone, never across a different phone', async () => {
      const mine = await placeGuestOrder(ACCOUNT_PHONE);
      const userToken = await signInUser(app);
      await gql(
        'mutation ($input: UpdateUserInput!) { updateMyProfile(updateMyProfileInput: $input) { id } }',
        { input: { phoneNumber: ACCOUNT_PHONE } },
        userToken,
      );
      expect(await myOrderIds(userToken)).not.toContain(mine.order.id);

      const code = await receiveCode(
        () => gql('mutation { requestPhoneVerification { phoneLast3 } }', undefined, userToken),
        ACCOUNT_PHONE,
      );
      expect(
        (await gql(`mutation { verifyPhone(input: { code: "${code}" }) { phoneVerified } }`, undefined, userToken))
          .errors,
      ).toBeUndefined();

      expect(await myOrderIds(userToken)).toContain(mine.order.id);
      const others = await prisma.order.findMany({ where: { guestPhone: OTHER_PHONE } });
      expect(others.every((order) => order.userId === null)).toBe(true);
    });
  });

  it('leaves signed-in checkout as it was', async () => {
    const userToken = await signInUser(app);
    await gql('mutation { addToCart(input: { variantId: "seed_var2", quantity: 1 }) { id } }', undefined, userToken);
    const quoted = await gql(
      '{ checkoutQuote(input: { fulfillmentType: PICKUP, pickupLocationId: "guest_pickup" }) { quoteHash } }',
      undefined,
      userToken,
    );
    expect(quoted.errors).toBeUndefined();
    const placed = await gql(
      `mutation ($h: String!) { createOrder(input: { fulfillmentType: PICKUP, pickupLocationId: "guest_pickup",
        contactEmail: "user@example.com", contactPhone: "+233244000111", quoteHash: $h }) { id userId status contactEmail } }`,
      { h: quoted.data!.checkoutQuote.quoteHash },
      userToken,
    );
    expect(placed.errors).toBeUndefined();
    expect(placed.data!.createOrder).toMatchObject({
      userId: 'seed_user',
      status: 'PLACED',
      contactEmail: 'user@example.com',
    });
  });

  async function cartIdOf(token: string): Promise<string | undefined> {
    const res = await gql('query ($t: String!) { guestCart(guestCartToken: $t) { id } }', { t: token });
    return res.data?.guestCart.id;
  }
});
