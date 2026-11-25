import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../../src/prisma/prisma.service';
import { NotificationsService } from '../../src/notifications/notifications.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';

const PASSWORD = 'Password@1';

const VERIFY = `
  mutation Verify($input: VerifyEmailInput!) {
    verifyEmail(input: $input)
  }
`;
const RESEND = `mutation { resendVerificationEmail }`;
const PROFILE = `query { userProfile { id email emailVerified pendingEmail } }`;
const UPDATE_PROFILE = `
  mutation Update($input: UpdateUserInput!, $currentPassword: String) {
    updateMyProfile(updateMyProfileInput: $input, currentPassword: $currentPassword) {
      id
      email
      pendingEmail
      emailVerified
    }
  }
`;
const REFRESH = `
  mutation Refresh($input: RefreshTokenInput!) {
    refreshToken(input: $input) { accessToken refreshToken }
  }
`;

describe('Email verification (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let verificationEmails: jest.SpyInstance;
  let changeNotices: jest.SpyInstance;
  let welcomeEmails: jest.SpyInstance;
  let accountCounter = 0;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
    const notifications = app.get(NotificationsService);
    verificationEmails = jest.spyOn(notifications, 'sendEmailVerification');
    changeNotices = jest.spyOn(notifications, 'sendEmailChangeRequested');
    welcomeEmails = jest.spyOn(notifications, 'sendWelcomeEmail');
  });

  afterAll(() => app.close());

  const tokensSentTo = (email: string): string[] =>
    verificationEmails.mock.calls.filter(([, to]) => to === email).map(([, , token]) => token as string);

  // Sign-up sends its verification email after responding.
  const waitForTokenSentTo = async (email: string, count = 1): Promise<string> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const tokens = tokensSentTo(email);
      if (tokens.length >= count) return tokens[count - 1];
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`No verification email #${count} was sent to ${email}`);
  };

  const newAccount = async () => {
    accountCounter += 1;
    const email = `verify${accountCounter}@test.com`;
    const tokens = await signUpUser(app, { name: 'Verify User', email, password: PASSWORD });
    const token = await waitForTokenSentTo(email);
    return { ...tokens, email, verificationToken: token };
  };

  const verify = (token: string) => gqlRequest(app, VERIFY, { input: { token } }).expect(200);
  const profile = async (accessToken: string) =>
    (await gqlRequest(app, PROFILE, undefined, accessToken).expect(200)).body.data.userProfile;

  describe('sign-up', () => {
    it('leaves a new account unverified until the emailed token is used, then sends the welcome email', async () => {
      const { accessToken, email, verificationToken } = await newAccount();
      expect(await profile(accessToken)).toMatchObject({ email, emailVerified: false, pendingEmail: null });
      expect(welcomeEmails).not.toHaveBeenCalledWith(expect.any(String), email, expect.anything());

      const res = await verify(verificationToken);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.verifyEmail).toBe(true);
      expect(await profile(accessToken)).toMatchObject({ email, emailVerified: true });
      expect(welcomeEmails).toHaveBeenCalledWith(expect.any(String), email, 'verify user');
    });

    it('stores only a hash of the token', async () => {
      const { email, verificationToken } = await newAccount();

      const user = await prisma.user.findUniqueOrThrow({ where: { email } });

      expect(user.emailVerificationToken).toEqual(expect.any(String));
      expect(user.emailVerificationToken).not.toBe(verificationToken);
    });

    it('accepts a token only once', async () => {
      const { verificationToken } = await newAccount();
      expect((await verify(verificationToken)).body.errors).toBeUndefined();

      const again = await verify(verificationToken);

      expect(again.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(again.body.errors[0].message).toMatch(/invalid or expired verification token/i);
    });

    it('lets exactly one of several concurrent uses of a token succeed', async () => {
      const { verificationToken } = await newAccount();

      const responses = await Promise.all(Array.from({ length: 4 }, () => verify(verificationToken)));

      expect(responses.filter((res) => res.body.errors === undefined)).toHaveLength(1);
    });

    it('rejects an expired token', async () => {
      const { email, verificationToken, accessToken } = await newAccount();
      await prisma.user.update({ where: { email }, data: { emailVerificationTokenExp: new Date(Date.now() - 1000) } });

      const res = await verify(verificationToken);

      expect(res.body.errors[0].message).toMatch(/invalid or expired verification token/i);
      expect((await profile(accessToken)).emailVerified).toBe(false);
    });

    it('rejects an unknown token', async () => {
      const res = await verify('not-a-real-token');

      expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
    });
  });

  describe('resendVerificationEmail', () => {
    it('requires a signed-in user', async () => {
      const res = await gqlRequest(app, RESEND).expect(200);

      expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    });

    it('sends a new token that replaces the previous one', async () => {
      const { accessToken, email, verificationToken: first } = await newAccount();
      await prisma.user.update({
        where: { email },
        data: { emailVerificationTokenExp: new Date(Date.now() + 23 * 60 * 60 * 1000) },
      });

      const res = await gqlRequest(app, RESEND, undefined, accessToken).expect(200);

      expect(res.body.errors).toBeUndefined();
      const second = await waitForTokenSentTo(email, 2);
      expect((await verify(first)).body.errors[0].message).toMatch(/invalid or expired/i);
      expect((await verify(second)).body.errors).toBeUndefined();
    });

    it('refuses a resend within a minute of the last email', async () => {
      const { accessToken } = await newAccount();

      const res = await gqlRequest(app, RESEND, undefined, accessToken).expect(200);

      expect(res.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(res.body.errors[0].message).toMatch(/less than a minute ago/i);
    });

    it('refuses when the email is already verified', async () => {
      const { accessToken, verificationToken } = await newAccount();
      await verify(verificationToken);

      const res = await gqlRequest(app, RESEND, undefined, accessToken).expect(200);

      expect(res.body.errors[0].message).toMatch(/already verified/i);
    });
  });

  describe('email change', () => {
    const changeEmail = (accessToken: string, email: string, currentPassword?: string) =>
      gqlRequest(app, UPDATE_PROFILE, { input: { email }, currentPassword }, accessToken).expect(200);

    it('requires the current password', async () => {
      const { accessToken, email } = await newAccount();

      const missing = await changeEmail(accessToken, `new-${email}`);
      const wrong = await changeEmail(accessToken, `new-${email}`, 'Wrong@123');

      expect(missing.body.errors[0].extensions.code).toBe('BAD_REQUEST');
      expect(missing.body.errors[0].message).toMatch(/currentPassword is required/i);
      expect(wrong.body.errors[0].extensions.code).toBe('FORBIDDEN');
      expect(await profile(accessToken)).toMatchObject({ email, pendingEmail: null });
    });

    it('keeps the current email and sessions until the new address is verified, then switches and signs out everywhere', async () => {
      const { accessToken, refreshToken, email } = await newAccount();
      const newEmail = `changed-${email}`;

      const requested = await changeEmail(accessToken, newEmail, PASSWORD);

      expect(requested.body.errors).toBeUndefined();
      expect(requested.body.data.updateMyProfile).toMatchObject({ email, pendingEmail: newEmail });
      expect(changeNotices).toHaveBeenCalledWith(expect.any(String), email, newEmail);
      const stillSignedIn = await gqlRequest(app, REFRESH, { input: { refreshToken } }).expect(200);
      expect(stillSignedIn.body.errors).toBeUndefined();

      const verified = await verify(tokensSentTo(newEmail)[0]);

      expect(verified.body.errors).toBeUndefined();
      const user = await prisma.user.findUniqueOrThrow({ where: { email: newEmail } });
      expect(user.pendingEmail).toBeNull();
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(await prisma.refreshToken.count({ where: { userId: user.id, revoked: false } })).toBe(0);
      const signIn = await gqlRequest(
        app,
        `mutation { signIn(input: { email: "${newEmail}", password: "${PASSWORD}" }) { accessToken } }`,
      ).expect(200);
      expect(signIn.body.errors).toBeUndefined();
    });

    it('refuses an address another account already uses', async () => {
      const { accessToken } = await newAccount();

      const res = await changeEmail(accessToken, 'admin@example.com', PASSWORD);

      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
      expect((await profile(accessToken)).pendingEmail).toBeNull();
    });

    it('cancels the change if another account takes the address before it is verified', async () => {
      const { accessToken, email } = await newAccount();
      const contested = `contested-${email}`;
      await changeEmail(accessToken, contested, PASSWORD);
      await signUpUser(app, { name: 'Quick Taker', email: contested, password: PASSWORD });

      const res = await verify(tokensSentTo(contested)[0]);

      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(await profile(accessToken)).toMatchObject({ email, pendingEmail: null });
    });

    it("sends an admin's change of a customer's email through verification of the new address", async () => {
      const { email } = await newAccount();
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      const adminToken = await signInAdmin(app);
      const newEmail = `admin-set-${email}`;

      const res = await gqlRequest(
        app,
        `mutation Update($id: String!, $input: UpdateUserInput!) {
          updateUser(id: $id, updateUserInput: $input) { email pendingEmail }
        }`,
        { id: user.id, input: { email: newEmail } },
        adminToken,
      ).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.updateUser).toEqual({ email, pendingEmail: newEmail });
      expect(changeNotices).toHaveBeenCalledWith(expect.any(String), email, newEmail);
      expect((await verify(tokensSentTo(newEmail)[0])).body.errors).toBeUndefined();
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email).toBe(newEmail);
    });
  });
});
