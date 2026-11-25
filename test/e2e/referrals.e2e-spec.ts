import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { PrismaService } from '../../src/prisma/prisma.service';
import { PaystackClient } from '../../src/payment/paystack.client';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { signInAdmin, signInSuperAdmin, signInUser } from '../helpers/auth.helper';
import { relaxVelocityLimits, resetDb, seedMinimal, setStock, verifyPhoneForCod } from '../helpers/db.helper';

interface GqlResult {
  data?: Record<string, any>;
  errors?: { message: string; extensions: { code: string; reason?: string } }[];
}

const MINE = 'code referredBy pendingCount rewardedCount pointsEarned referrals { displayName status }';

describe('Referrals (P6-L.2, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let referrerToken: string;
  let referrerCode: string;
  let customers = 0;
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
    createRefund: jest.fn(async () => ({ id: `rf_referral_${refundKey}`, status: 'pending' })),
  };

  const gql = async (query: string, token = adminToken, variables?: Record<string, unknown>): Promise<GqlResult> =>
    (await gqlRequest(app, query, variables, token).expect(200)).body;
  const reasonOf = (result: GqlResult) => result.errors?.[0]?.extensions.reason;

  const signUp = async (name: string, referralCode?: string): Promise<GqlResult> =>
    gql(`mutation($input: SignUpInput!) { signUp(input: $input) { accessToken } }`, '', {
      input: {
        name,
        email: `${name.toLowerCase().replace(/\s/g, '')}.${customers}@example.com`,
        password: 'Referral@1234',
        referralCode,
      },
    });
  /** A new customer who signed up with `code`, with a delivery address and, unless `verified` is false, a verified phone. */
  const newCustomer = async (name: string, code: string | null = referrerCode, verified = true) => {
    customers += 1;
    const res = await signUp(name, code ?? undefined);
    expect(res.errors).toBeUndefined();
    const token = res.data!.signUp.accessToken as string;
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: `${name.toLowerCase().replace(/\s/g, '')}.${customers}@example.com` },
    });
    const phone = `+2332445${String(customers).padStart(5, '0')}`;
    if (verified) await verifyPhoneForCod(prisma, user.id, phone);
    const address = await prisma.address.create({
      data: {
        userId: user.id,
        recipientName: name,
        phone,
        region: 'GREATER_ACCRA',
        street: '2 Friend St',
        city: 'Accra',
        country: 'GH',
      },
    });
    return { userId: user.id, token, addressId: address.id };
  };
  const completedOrder = async (customer: { token: string; addressId: string }) => {
    await gql(`mutation { addToCart(input: { variantId: "seed_var2", quantity: 1 }) { id } }`, customer.token);
    const input = { fulfillmentType: 'DELIVERY', shippingAddressId: customer.addressId };
    const quoted = await gql(
      `query($input: CheckoutQuoteInput!) { checkoutQuote(input: $input) { quoteHash } }`,
      customer.token,
      {
        input,
      },
    );
    expect(quoted.errors).toBeUndefined();
    const created = await gql(
      `mutation($input: CreateOrderInput!) { createOrder(input: $input) { id items { id } } }`,
      customer.token,
      {
        input: {
          ...input,
          contactEmail: 'friend@example.com',
          contactPhone: '+233244000000',
          quoteHash: quoted.data!.checkoutQuote.quoteHash,
        },
      },
    );
    expect(created.errors).toBeUndefined();
    const order = created.data!.createOrder as { id: string; items: { id: string }[] };
    await request(app.getHttpServer())
      .post('/payment/initialize')
      .set('Authorization', `Bearer ${customer.token}`)
      .send({ orderId: order.id, paymentMethod: 'CARD' })
      .expect(201);
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { intent: { orderId: order.id } } });
    expect(
      (
        await gql(
          `mutation { verifyPayment(verifyPaymentInput: { reference: "${attempt.reference}" }) { status } }`,
          customer.token,
        )
      ).errors,
    ).toBeUndefined();
    const shipment = await gql(`mutation { createShipment(input: { orderId: "${order.id}" }) { id } }`);
    for (const status of ['OUT_FOR_DELIVERY', 'DELIVERED']) {
      const moved = await gql(
        `mutation { updateShipmentStatus(input: { shipmentId: "${shipment.data!.createShipment.id}", status: ${status} }) { id } }`,
      );
      expect(moved.errors).toBeUndefined();
    }
    return order;
  };
  const referralOf = (refereeId: string) => prisma.referral.findUniqueOrThrow({ where: { refereeId } });
  const referralPoints = (userId: string) =>
    prisma.loyaltyTransaction.findMany({ where: { userId, referralId: { not: null } }, orderBy: { createdAt: 'asc' } });

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp((builder) => builder.overrideProvider(PaystackClient).useValue(paystack)));
    await resetDb(prisma);
    await seedMinimal(prisma);
    await setStock(prisma, 'seed_var2', 500);
    adminToken = await signInAdmin(app);
    referrerToken = await signInUser(app);
    const mine = await gql(`{ myReferrals { ${MINE} } }`, referrerToken);
    referrerCode = mine.data!.myReferrals.code;
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  it('gives each customer one short, unambiguous code, created when first asked for', async () => {
    expect(referrerCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{8}$/);
    expect((await gql(`{ myReferrals { code } }`, referrerToken)).data!.myReferrals.code).toBe(referrerCode);
  });

  it('rewards both once when the new customer’s first order completes, never for the second order', async () => {
    const friend = await newCustomer(
      'kofi boateng',
      `${referrerCode.slice(0, 4).toLowerCase()}-${referrerCode.slice(4)}`,
    );
    expect(await referralOf(friend.userId)).toMatchObject({ status: 'PENDING', referrerId: 'seed_user' });
    expect((await gql(`{ myReferrals { ${MINE} } }`, referrerToken)).data!.myReferrals).toMatchObject({
      pendingCount: 1,
      referrals: [{ displayName: 'Kofi', status: 'PENDING' }],
    });
    expect((await gql(`{ myReferrals { referredBy } }`, friend.token)).data!.myReferrals.referredBy).toBe('Regular');

    const first = await completedOrder(friend);
    expect(await referralOf(friend.userId)).toMatchObject({
      status: 'REWARDED',
      orderId: first.id,
      refereePoints: 500,
    });
    expect((await referralPoints(friend.userId)).map((t) => [t.type, t.points])).toEqual([['REFERRAL', 500]]);
    expect((await referralPoints('seed_user')).map((t) => [t.type, t.points])).toEqual([['REFERRAL', 500]]);

    await completedOrder(friend);
    expect(await referralPoints(friend.userId)).toHaveLength(1);
    expect(await referralPoints('seed_user')).toHaveLength(1);
    const mine = (await gql(`{ myReferrals { ${MINE} } }`, referrerToken)).data!.myReferrals;
    expect(mine).toMatchObject({ pendingCount: 0, rewardedCount: 1, pointsEarned: 500 });
    const staff = (
      await gql(`{ customerReferrals(userId: "seed_user") { code referrals { refereeId status referrerPoints } } }`)
    ).data!.customerReferrals;
    expect(staff).toEqual({
      code: referrerCode,
      referrals: [{ refereeId: friend.userId, status: 'REWARDED', referrerPoints: 500 }],
    });
  });

  it('refuses an unknown code at sign-up without creating the account', async () => {
    customers += 1;
    const refused = await signUp('Nobody', 'ZZZZ2222');
    expect(reasonOf(refused)).toBe('INVALID_REFERRAL_CODE');
    expect(await prisma.user.count({ where: { email: `nobody.${customers}@example.com` } })).toBe(0);
  });

  it('refuses self-referral, a second code, a code after an order, and mutual referrals', async () => {
    const apply = (token: string, code: string) =>
      gql(`mutation { applyReferralCode(input: { code: "${code}" }) { code } }`, token);
    expect(reasonOf(await apply(referrerToken, referrerCode))).toBe('SELF_REFERRAL');

    const ama = await newCustomer('ama', referrerCode);
    expect(reasonOf(await apply(ama.token, referrerCode))).toBe('ALREADY_REFERRED');

    const yaw = await newCustomer('yaw', null);
    const amaCode = (await gql(`{ myReferrals { code } }`, ama.token)).data!.myReferrals.code;
    const applied = await apply(yaw.token, amaCode);
    expect(applied.errors).toBeUndefined();
    expect(await referralOf(yaw.userId)).toMatchObject({ referrerId: ama.userId, status: 'PENDING' });

    const esi = await newCustomer('esi', null);
    expect(reasonOf(await apply(esi.token, 'NOTACODE!'))).toBe('INVALID_REFERRAL_CODE');
    await completedOrder(esi);
    expect(reasonOf(await apply(esi.token, amaCode))).toBe('HAS_ORDERS');

    // Kojo referred Kwame; Kwame's code cannot then refer Kojo back.
    const kojo = await newCustomer('kojo', null);
    const kojoCode = (await gql(`{ myReferrals { code } }`, kojo.token)).data!.myReferrals.code;
    const kwame = await newCustomer('kwame', kojoCode);
    const kwameCode = (await gql(`{ myReferrals { code } }`, kwame.token)).data!.myReferrals.code;
    expect(reasonOf(await apply(kojo.token, kwameCode))).toBe('MUTUAL_REFERRAL');
    expect(await prisma.referral.count({ where: { refereeId: kojo.userId } })).toBe(0);
  });

  it('does not qualify a first order without a verified phone, nor any later order', async () => {
    const friend = await newCustomer('efua', referrerCode, false);
    await completedOrder(friend);
    expect(await referralOf(friend.userId)).toMatchObject({
      status: 'DISQUALIFIED',
      disqualifiedReason: 'PHONE_NOT_VERIFIED',
    });

    await verifyPhoneForCod(prisma, friend.userId, '+233244999001');
    await completedOrder(friend);
    expect(await referralPoints(friend.userId)).toEqual([]);
  });

  it('takes both rewards back when the first order is fully refunded within the return window', async () => {
    const friend = await newCustomer('akosua', referrerCode);
    const order = await completedOrder(friend);
    const before = (await referralPoints('seed_user')).length;

    refundKey += 1;
    const refunded = await gql(
      `mutation($input: RefundOrderInput!) { refundOrder(input: $input) { status } }`,
      adminToken,
      {
        input: {
          orderId: order.id,
          lines: [{ orderItemId: order.items[0].id, quantity: 1 }],
          reason: 'DAMAGED',
          idempotencyKey: `referral-refund-${String(refundKey).padStart(4, '0')}`,
        },
      },
    );
    expect(refunded.errors).toBeUndefined();

    expect(await referralOf(friend.userId)).toMatchObject({ status: 'REVERSED' });
    expect((await referralPoints(friend.userId)).map((t) => [t.type, t.points + t.debtChange * -1])).toEqual([
      ['REFERRAL', 500],
      ['REVERSE', -500],
    ]);
    const referrer = await referralPoints('seed_user');
    expect(referrer).toHaveLength(before + 1);
    expect(referrer[referrer.length - 1]).toMatchObject({ type: 'REVERSE' });
  });

  it('rewards no referral completing while referrals are switched off, and works again once on (P8-F)', async () => {
    const ownerToken = await signInSuperAdmin(app);
    const switchReferrals = async (enabled: boolean) =>
      expect(
        (
          await gql(
            `mutation { setStoreFeature(input: { key: REFERRALS, enabled: ${enabled} }) { enabled } }`,
            ownerToken,
          )
        ).errors,
      ).toBeUndefined();
    const pending = await newCustomer('abena', referrerCode);

    await switchReferrals(false);
    expect(reasonOf(await gql(`{ myReferrals { code } }`, referrerToken))).toBe('FEATURE_DISABLED');
    await completedOrder(pending);
    expect(await referralOf(pending.userId)).toMatchObject({
      status: 'DISQUALIFIED',
      disqualifiedReason: 'REFERRALS_DISABLED',
    });
    expect(await referralPoints(pending.userId)).toEqual([]);

    await switchReferrals(true);
    const later = await newCustomer('kwesi', referrerCode);
    await completedOrder(later);
    expect(await referralOf(later.userId)).toMatchObject({ status: 'REWARDED' });
  });

  it('refuses a code used too often today and flags those over the soft limit', async () => {
    await prisma.velocityLimit.updateMany({
      where: { rule: 'REFERRALS_PER_REFERRER_24H' },
      data: { softLimit: 1, hardLimit: 2 },
    });
    const host = await newCustomer('popular', null);
    const code = (await gql(`{ myReferrals { code } }`, host.token)).data!.myReferrals.code;

    const first = await newCustomer('one', code);
    const second = await newCustomer('two', code);
    customers += 1;
    const third = await signUp('Three', code);

    expect(await referralOf(first.userId)).toMatchObject({ velocityFlagged: false });
    expect(await referralOf(second.userId)).toMatchObject({ velocityFlagged: true });
    expect(reasonOf(third)).toBe('VELOCITY_LIMIT');
    await relaxVelocityLimits(prisma);
  });
});
