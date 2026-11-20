import { INestApplication } from '@nestjs/common';
import { Redis } from 'ioredis';
import { PrismaService } from '../../src/prisma/prisma.service';
import { REDIS_CLIENT } from '../../src/redis/redis.module';
import { base32Decode, hotp, timeStep, totp } from '../../src/iam/mfa/totp';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import {
  allowTotpReuse,
  signInSuperAdmin,
  signInUser,
  signInWithPassword,
  signUpUser,
  testTotpCode,
} from '../helpers/auth.helper';

const PASSWORD = 'Passw0rd!x';

describe('Two-factor authentication and step-up (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let ownerToken: string;

  const gql = (query: string, token?: string, variables?: Record<string, unknown>) =>
    gqlRequest(app, query, variables, token).expect(200);
  const signIn = (email: string, password = PASSWORD) =>
    gql('mutation S($input: SignInInput!) { signIn(input: $input) { accessToken refreshToken } }', undefined, {
      input: { email, password },
    });
  const complete = (challenge: string, code: string) =>
    gql(
      'mutation C($input: CompleteMfaSignInInput!) { completeMfaSignIn(input: $input) { accessToken refreshToken } }',
      undefined,
      { input: { challenge, code } },
    );
  const stepUp = (token: string, code: string) =>
    gql('mutation S($code: String!) { stepUp(code: $code) { validUntil } }', token, { code });
  const forgetStepUps = async () => {
    const keys = await redis.keys('mfa:step-up:*');
    if (keys.length > 0) await redis.del(...keys);
  };
  const reasonOf = (res: { body: { errors?: { extensions: { reason?: string } }[] } }) =>
    res.body.errors?.[0].extensions.reason;

  /** A new account given `roleKey` by the seeded Owner, signed in with a password only. */
  const newStaff = async (email: string, roleKey: string) => {
    await signUpUser(app, { email, password: PASSWORD, name: 'New Staff' });
    const { id } = await prisma.user.findUniqueOrThrow({ where: { email } });
    const assigned = await gql(
      `mutation { assignStaffRole(userId: "${id}", roleKey: "${roleKey}") { role { key } } }`,
      ownerToken,
    );
    expect(assigned.body.errors).toBeUndefined();
    const res = await signIn(email);
    return { id, token: res.body.data.signIn.accessToken as string };
  };

  /** Enrols through the API and returns the secret and recovery codes. */
  const enrol = async (token: string) => {
    const started = await gql('mutation { startMfaEnrollment { secret otpauthUri } }', token);
    expect(started.body.errors).toBeUndefined();
    const { secret } = started.body.data.startMfaEnrollment;
    const confirmed = await gql(
      'mutation C($code: String!) { confirmMfaEnrollment(code: $code) { recoveryCodes } }',
      token,
      { code: totp(base32Decode(secret), Date.now()) },
    );
    expect(confirmed.body.errors).toBeUndefined();
    return {
      secret: secret as string,
      recoveryCodes: confirmed.body.data.confirmMfaEnrollment.recoveryCodes as string[],
    };
  };

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    redis = app.get(REDIS_CLIENT);
    await resetDb(prisma);
    await seedMinimal(prisma);
    await prisma.store.update({ where: { singleton: true }, data: { tradingName: 'Ama Shop' } });
    ownerToken = await signInSuperAdmin(app);
  });

  afterAll(() => app.close());

  describe('enforcement for Owner and Manager', () => {
    it.each(['MANAGER', 'OWNER'])('blocks a %s without MFA from staff operations until they enrol', async (roleKey) => {
      const staff = await newStaff(`unenrolled-${roleKey.toLowerCase()}@example.com`, roleKey);

      const blocked = await gql('{ orders { id } }', staff.token);
      const ownProfile = await gql('{ userProfile { mfaEnabled staffRole { key } } }', staff.token);
      await enrol(staff.token);
      const allowed = await gql('{ orders { id } }', staff.token);

      expect(blocked.body.errors[0]).toMatchObject({
        extensions: { code: 'FORBIDDEN', reason: 'MFA_ENROLLMENT_REQUIRED' },
      });
      expect(ownProfile.body.data.userProfile).toEqual({ mfaEnabled: false, staffRole: { key: roleKey } });
      expect(allowed.body.errors).toBeUndefined();
    });

    it('lets other staff work without MFA', async () => {
      const cashier = await newStaff('cashier-no-mfa@example.com', 'CASHIER');

      const res = await gql('{ orders { id } }', cashier.token);

      expect(res.body.errors).toBeUndefined();
    });

    it('leaves customers alone: password sign-in and self-service work, staff operations stay FORBIDDEN', async () => {
      const customerToken = await signInUser(app);

      const own = await gql('{ userProfile { email mfaEnabled } }', customerToken);
      const staffOnly = await gql('{ orders { id } }', customerToken);

      expect(own.body.data.userProfile).toEqual({ email: 'user@example.com', mfaEnabled: false });
      expect(staffOnly.body.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN' });
      expect(staffOnly.body.errors[0].extensions.reason).toBeUndefined();
    });
  });

  describe('enrolment', () => {
    it('returns an otpauth URI, then 10 recovery codes once; stores the secret encrypted and the codes hashed', async () => {
      const staff = await newStaff('enrolling@example.com', 'MANAGER');
      const started = await gql('mutation { startMfaEnrollment { secret otpauthUri } }', staff.token);
      const { secret, otpauthUri } = started.body.data.startMfaEnrollment;
      const wrong = await gql('mutation { confirmMfaEnrollment(code: "000000") { recoveryCodes } }', staff.token);

      const confirmed = await gql(
        'mutation C($code: String!) { confirmMfaEnrollment(code: $code) { recoveryCodes } }',
        staff.token,
        { code: totp(base32Decode(secret), Date.now()) },
      );
      const again = await gql('mutation { startMfaEnrollment { secret } }', staff.token);

      expect(otpauthUri).toBe(
        `otpauth://totp/Ama%20Shop:enrolling%40example.com?secret=${secret}&issuer=Ama%20Shop&algorithm=SHA1&digits=6&period=30`,
      );
      expect(wrong.body.errors[0]).toMatchObject({
        message: 'Invalid two-factor code',
        extensions: { code: 'BAD_REQUEST' },
      });
      const codes: string[] = confirmed.body.data.confirmMfaEnrollment.recoveryCodes;
      expect(codes).toHaveLength(10);
      expect(again.body.errors[0].extensions.code).toBe('CONFLICT');

      const row = await prisma.user.findUniqueOrThrow({ where: { id: staff.id }, include: { mfaRecoveryCodes: true } });
      expect(row.mfaEnabledAt).not.toBeNull();
      expect(row.mfaSecret).toMatch(/^v1\./);
      expect(row.mfaSecret).not.toContain(secret);
      expect(row.mfaRecoveryCodes).toHaveLength(10);
      expect(JSON.stringify(row.mfaRecoveryCodes)).not.toContain(codes[0]);
      expect(await prisma.auditLog.count({ where: { entityId: staff.id, action: 'MFA_ENABLE' } })).toBe(1);
    });
  });

  describe('sign-in with a second factor', () => {
    let email: string;
    let secret: string;
    let recoveryCodes: string[];

    beforeAll(async () => {
      email = 'mfa-signin@example.com';
      const staff = await newStaff(email, 'MANAGER');
      ({ secret, recoveryCodes } = await enrol(staff.token));
    });

    const challenge = async () => {
      const res = await signIn(email);
      expect(res.body.data).toBeNull();
      expect(res.body.errors[0]).toMatchObject({ extensions: { code: 'UNAUTHENTICATED', reason: 'MFA_REQUIRED' } });
      return res.body.errors[0].extensions.mfaChallenge as string;
    };

    it('requires the second factor after a correct password and completes with an authenticator code', async () => {
      const mfaChallenge = await challenge();
      await prisma.user.update({ where: { email }, data: { mfaLastUsedStep: null } });

      const res = await complete(mfaChallenge, totp(base32Decode(secret), Date.now()));
      const me = await gql('{ userProfile { email } }', res.body.data.completeMfaSignIn.accessToken);

      expect(res.body.errors).toBeUndefined();
      expect(me.body.data.userProfile.email).toBe(email);
    });

    it('refuses a wrong code, a replayed code and a tampered or reused-as-access-token challenge', async () => {
      const mfaChallenge = await challenge();
      await prisma.user.update({ where: { email }, data: { mfaLastUsedStep: null } });
      const step = timeStep(Date.now());
      const code = hotp(base32Decode(secret), step);

      const wrong = await complete(mfaChallenge, code === '123456' ? '654321' : '123456');
      const first = await complete(mfaChallenge, code);
      const replay = await complete(mfaChallenge, code);
      const tampered = await complete(`${mfaChallenge.slice(0, -2)}xx`, code);
      const asAccessToken = await gql('{ userProfile { email } }', mfaChallenge);

      expect(wrong.body.errors[0]).toMatchObject({
        message: 'Invalid two-factor code',
        extensions: { code: 'UNAUTHENTICATED' },
      });
      expect(first.body.errors).toBeUndefined();
      expect(replay.body.errors[0].message).toBe('Invalid two-factor code');
      expect(tampered.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
      expect(asAccessToken.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    it('accepts each recovery code once', async () => {
      const first = await complete(await challenge(), recoveryCodes[0].toUpperCase());
      const reused = await complete(await challenge(), recoveryCodes[0]);

      expect(first.body.errors).toBeUndefined();
      expect(reused.body.errors[0].message).toBe('Invalid two-factor code');
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(await prisma.mfaRecoveryCode.count({ where: { userId: user.id, usedAt: { not: null } } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityId: user.id, action: 'MFA_RECOVERY_CODE_USED' } })).toBe(1);
    });

    describe('social sign-in', () => {
      let fetchMock: jest.SpyInstance;

      afterEach(() => fetchMock.mockRestore());

      it('does not let Google sign-in skip the second factor', async () => {
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        await prisma.authProvider.create({
          data: { userId: user.id, providerId: 'google-mfa-staff', provider: 'Google' },
        });
        fetchMock = jest.spyOn(global, 'fetch').mockImplementation(((url: URL) => {
          const body =
            url.hostname === 'oauth2.googleapis.com'
              ? { sub: 'google-mfa-staff', aud: process.env.GOOGLE_CLIENT_ID }
              : { sub: 'google-mfa-staff', email, email_verified: true };
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }) as typeof fetch);

        const res = await gql(
          'mutation G($input: SocialLoginInput!) { signInWithGoogle(input: $input) { accessToken } }',
          undefined,
          { input: { token: 'google-token' } },
        );

        expect(res.body.data).toBeNull();
        expect(res.body.errors[0].extensions).toMatchObject({ code: 'UNAUTHENTICATED', reason: 'MFA_REQUIRED' });
      });
    });
  });

  describe('step-up for sensitive actions', () => {
    let managerToken: string;

    beforeEach(async () => {
      managerToken = (await signInWithPassword(app, 'admin@example.com', 'Admin@123')).accessToken;
      await forgetStepUps();
    });

    const changePrice = (token: string, basePrice: string) =>
      gql(
        `mutation { updateProduct(productId: "seed_prod1", updateProductInput: { basePrice: "${basePrice}" }) { id basePrice { amount } } }`,
        token,
      );

    it('refuses a price change without a recent verification and allows it after stepUp', async () => {
      const refused = await changePrice(managerToken, '899.99');
      const renamed = await gql(
        'mutation { updateProduct(productId: "seed_prod1", updateProductInput: { name: "Laptop Pro" }) { name } }',
        managerToken,
      );
      await allowTotpReuse(app, 'admin@example.com');
      const verified = await stepUp(managerToken, testTotpCode());
      const changed = await changePrice(managerToken, '899.99');

      expect(reasonOf(refused)).toBe('STEP_UP_REQUIRED');
      expect(refused.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(renamed.body.errors).toBeUndefined();
      expect(new Date(verified.body.data.stepUp.validUntil).getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
      expect(changed.body.errors).toBeUndefined();
      expect(changed.body.data.updateProduct.basePrice).toEqual({ amount: '899.99' });
      expect(await prisma.auditLog.count({ where: { entityId: 'seed_admin', action: 'STEP_UP' } })).toBeGreaterThan(0);
    });

    it('refuses refunds and role changes without a recent verification', async () => {
      const refund = await gql('mutation { processPendingRefund(refundId: "missing-refund") { id } }', managerToken);
      const ownerFresh = await signInSuperAdmin(app);
      await forgetStepUps();
      const role = await gql(
        'mutation { createStaffRole(input: { key: "LATE_ROLE", name: "Late", permissions: ["order.view"] }) { key } }',
        ownerFresh,
      );

      expect(reasonOf(refund)).toBe('STEP_UP_REQUIRED');
      expect(reasonOf(role)).toBe('STEP_UP_REQUIRED');

      await allowTotpReuse(app, 'admin@example.com');
      await stepUp(managerToken, testTotpCode());
      const afterStepUp = await gql(
        'mutation { processPendingRefund(refundId: "missing-refund") { id } }',
        managerToken,
      );
      expect(afterStepUp.body.errors[0].extensions.code).toBe('NOT_FOUND');
    });

    it('refuses a wrong code, and stepUp for an account without MFA', async () => {
      const customerToken = await signInUser(app);

      const wrong = await stepUp(managerToken, '000000');
      const noMfa = await stepUp(customerToken, '123456');

      expect(wrong.body.errors[0]).toMatchObject({
        message: 'Invalid two-factor code',
        extensions: { code: 'BAD_REQUEST' },
      });
      expect(noMfa.body.errors[0].message).toBe('Enrol two-factor authentication first');
    });

    it('treats an MFA sign-in as a fresh verification of the new session', async () => {
      const token = (await signInWithPassword(app, 'admin@example.com', 'Admin@123')).accessToken;

      const res = await changePrice(token, '949.99');

      expect(res.body.errors).toBeUndefined();
    });
  });
});
