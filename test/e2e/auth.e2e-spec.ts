import { INestApplication } from '@nestjs/common';
import { createValidationPipe } from '../../src/commons/validation-pipe';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'crypto';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AppModule } from '../../src/app.module';
import { LoggerService } from '../../src/commons/logger.service';
import { AllExceptionsFilter } from '../../src/commons/filters/all-exceptions.filter';
import { GqlThrottlerGuard } from '../../src/commons/guards/gql-throttler.guard';
import { GoogleAuthenticationService } from '../../src/iam/authentication/social/google-authentication.service';
import { FacebookAuthenticationService } from '../../src/iam/authentication/social/facebook-authentication.service';
import { createTestApp } from '../helpers/app.helper';
import { gqlRequest } from '../helpers/graphql.helper';
import { resetDb, seedMinimal } from '../helpers/db.helper';
import { signInAdmin, signUpUser } from '../helpers/auth.helper';
import { genSalt, hash } from 'bcrypt';

describe('Authentication (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    await resetDb(prisma);
    await seedMinimal(prisma);
  });

  afterAll(() => app.close());

  // ─── signUp ──────────────────────────────────────────────────────────────────

  describe('signUp', () => {
    it('returns an access + refresh token pair on valid input', async () => {
      // Arrange
      const mutation = `
        mutation {
          signUp(input: { name: "New User", email: "newuser@test.com", password: "Password@1" }) {
            accessToken
            refreshToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.signUp.accessToken).toBeDefined();
      expect(res.body.data.signUp.refreshToken).toBeDefined();
    });

    it('fails when the email is already registered (conflict)', async () => {
      // Arrange — seed_user email is already in the DB via seedMinimal
      const mutation = `
        mutation {
          signUp(input: { name: "Dup User", email: "user@example.com", password: "Password@1" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/already exist/i);
    });

    it('fails with an invalid email format', async () => {
      // Arrange
      const mutation = `
        mutation {
          signUp(input: { name: "Bad Email", email: "not-an-email", password: "Password@1" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });

    it('fails with a weak password (no uppercase, digit, or special character)', async () => {
      // Arrange
      const mutation = `
        mutation {
          signUp(input: { name: "Weak Pass", email: "weakpass@test.com", password: "weakpassword" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── signIn ──────────────────────────────────────────────────────────────────

  describe('signIn', () => {
    it('returns an access + refresh token pair on correct credentials', async () => {
      // Arrange
      const mutation = `
        mutation {
          signIn(input: { email: "user@example.com", password: "User@123" }) {
            accessToken
            refreshToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.signIn.accessToken).toBeDefined();
      expect(res.body.data.signIn.refreshToken).toBeDefined();
    });

    it('fails with a wrong password', async () => {
      // Arrange
      const mutation = `
        mutation {
          signIn(input: { email: "user@example.com", password: "Wrong@123" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid email or password/i);
    });

    it('fails with a non-existent email', async () => {
      // Arrange
      const mutation = `
        mutation {
          signIn(input: { email: "nobody@example.com", password: "Passwd@12" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid email or password/i);
    });
  });

  // ─── refreshToken ─────────────────────────────────────────────────────────────

  describe('refreshToken', () => {
    it('returns a new access + refresh token pair with a valid refresh token', async () => {
      // Arrange — sign in to obtain a token pair
      const signInMutation = `
        mutation {
          signIn(input: { email: "admin@example.com", password: "Admin@123" }) {
            accessToken
            refreshToken
          }
        }
      `;
      const signInRes = await gqlRequest(app, signInMutation).expect(200);
      expect(signInRes.body.errors).toBeUndefined();
      const { refreshToken } = signInRes.body.data.signIn as { accessToken: string; refreshToken: string };
      const mutation = `
        mutation Refresh($input: RefreshTokenInput!) {
          refreshToken(input: $input) {
            accessToken
            refreshToken
          }
        }
      `;

      // Act — pass the token via variables so it is JSON-serialised rather than
      // embedded as a raw string literal in the query document
      const res = await gqlRequest(app, mutation, { input: { refreshToken } }).expect(200);
      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.refreshToken.accessToken).toBeDefined();
      expect(res.body.data.refreshToken.refreshToken).toBeDefined();
      // New token must differ from the old one (rotation)
      expect(res.body.data.refreshToken.refreshToken).not.toBe(refreshToken);
    });

    it('fails with an invalid (fake) refresh token', async () => {
      // Arrange
      const mutation = `
        mutation {
          refreshToken(input: { refreshToken: "this.is.not.a.valid.jwt" }) {
            accessToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });

    it('fails with a revoked refresh token (used token is rejected)', async () => {
      // Arrange — sign in and immediately rotate the token once (revoking the original)
      const signInMutation = `
        mutation {
          signIn(input: { email: "super_admin@example.com", password: "SuperAdmin@123" }) {
            accessToken
            refreshToken
          }
        }
      `;
      const signInRes = await gqlRequest(app, signInMutation).expect(200);
      const { accessToken, refreshToken } = signInRes.body.data.signIn;

      // Revoke by signing out
      const signOutMutation = `
        mutation {
          signOut(input: { refreshToken: "${refreshToken}" })
        }
      `;
      await gqlRequest(app, signOutMutation, undefined, accessToken).expect(200);

      const mutation = `
        mutation {
          refreshToken(input: { refreshToken: "${refreshToken}" }) {
            accessToken
          }
        }
      `;

      // Act — attempt to refresh with the now-revoked token
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });
  });

  // ─── session security ────────────────────────────────────────────────────────

  describe('refresh sessions', () => {
    const REFRESH = `
      mutation Refresh($input: RefreshTokenInput!) {
        refreshToken(input: $input) {
          accessToken
          refreshToken
        }
      }
    `;
    let accountCounter = 0;

    const refresh = (refreshToken: string) => gqlRequest(app, REFRESH, { input: { refreshToken } }).expect(200);

    const newAccount = async () => {
      accountCounter += 1;
      const email = `session${accountCounter}@test.com`;
      const tokens = await signUpUser(app, { name: 'Session User', email, password: 'Password@1' });
      const user = await prisma.user.findUniqueOrThrow({ where: { email } });
      return { ...tokens, userId: user.id, email };
    };

    it('lets exactly one of several concurrent refreshes with the same token succeed', async () => {
      const { refreshToken, userId } = await newAccount();

      const responses = await Promise.all(Array.from({ length: 5 }, () => refresh(refreshToken)));

      const succeeded = responses.filter((res) => res.body.errors === undefined);
      expect(succeeded).toHaveLength(1);
      expect(succeeded[0].body.data.refreshToken.refreshToken).toEqual(expect.any(String));
      responses
        .filter((res) => res.body.errors !== undefined)
        .forEach((res) => expect(res.body.errors[0].message).toMatch(/invalid or expired/i));
      // The losing duplicates count as reuse, so the whole session (including the winner's new token) is revoked.
      expect(await prisma.refreshToken.count({ where: { userId, revoked: false } })).toBe(0);
    });

    it('kills the session when an already-rotated token is presented again', async () => {
      const { refreshToken: original } = await newAccount();
      const rotated = await refresh(original);
      expect(rotated.body.errors).toBeUndefined();
      const current = rotated.body.data.refreshToken.refreshToken as string;

      const replay = await refresh(original);
      expect(replay.body.errors[0].message).toMatch(/invalid or expired/i);

      const afterReplay = await refresh(current);
      expect(afterReplay.body.errors[0].message).toMatch(/invalid or expired/i);
    });

    it('refuses to refresh a session older than the absolute lifetime', async () => {
      const { userId } = await newAccount();
      const jwtService = app.get(JwtService);
      const thirtyOneDaysAgo = Math.floor(Date.now() / 1000) - 31 * 86400;
      const staleToken = await jwtService.signAsync(
        { sub: userId, sessionStart: thirtyOneDaysAgo },
        {
          secret: process.env.JWT_REFRESH_SECRET,
          audience: process.env.JWT_TOKEN_AUDIENCE,
          issuer: process.env.JWT_TOKEN_ISSUER,
          expiresIn: 3600,
          jwtid: 'stale-session',
        },
      );
      await prisma.refreshToken.create({
        data: {
          userId,
          tokenHash: createHash('sha256').update(staleToken).digest('hex'),
          expiresAt: new Date(Date.now() + 3600_000),
        },
      });

      const res = await refresh(staleToken);

      expect(res.body.errors[0].message).toMatch(/session has expired/i);
    });

    it('revokes every session when the user changes their password', async () => {
      const { accessToken, refreshToken } = await newAccount();
      const mutation = `
        mutation Change($input: ChangeUserPasswordInput!) {
          changeUserPassword(input: $input) { id }
        }
      `;

      const change = await gqlRequest(
        app,
        mutation,
        { input: { oldPassword: 'Password@1', newPassword: 'Changed@123' } },
        accessToken,
      ).expect(200);
      expect(change.body.errors).toBeUndefined();

      const res = await refresh(refreshToken);
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });

    it('revokes every session when the user changes their email', async () => {
      const { accessToken, refreshToken, email } = await newAccount();
      const mutation = `
        mutation Update($input: UpdateUserInput!) {
          updateMyProfile(updateMyProfileInput: $input) { id }
        }
      `;

      const update = await gqlRequest(app, mutation, { input: { email: `moved-${email}` } }, accessToken).expect(200);
      expect(update.body.errors).toBeUndefined();

      const res = await refresh(refreshToken);
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });

    it('revokes every session when an admin archives the account', async () => {
      const { refreshToken, userId } = await newAccount();
      const adminToken = await signInAdmin(app);

      const archive = await gqlRequest(
        app,
        `mutation { archiveUser(id: "${userId}") { id } }`,
        undefined,
        adminToken,
      ).expect(200);
      expect(archive.body.errors).toBeUndefined();

      expect(await prisma.refreshToken.count({ where: { userId, revoked: false } })).toBe(0);
      const res = await refresh(refreshToken);
      expect(res.body.errors).toBeDefined();
    });
  });

  // ─── signOut ──────────────────────────────────────────────────────────────────

  describe('signOut', () => {
    it('revokes the refresh token so subsequent refreshes fail', async () => {
      // Arrange — get a fresh token pair
      const signInMutation = `
        mutation {
          signIn(input: { email: "user@example.com", password: "User@123" }) {
            accessToken
            refreshToken
          }
        }
      `;
      const signInRes = await gqlRequest(app, signInMutation).expect(200);
      const { accessToken, refreshToken } = signInRes.body.data.signIn;

      const signOutMutation = `
        mutation {
          signOut(input: { refreshToken: "${refreshToken}" })
        }
      `;

      // Act
      const signOutRes = await gqlRequest(app, signOutMutation, undefined, accessToken).expect(200);

      // Assert — signOut reports success
      expect(signOutRes.body.errors).toBeUndefined();
      expect(signOutRes.body.data.signOut).toBe(true);

      // Assert — the revoked token can no longer be used to refresh
      const refreshMutation = `
        mutation {
          refreshToken(input: { refreshToken: "${refreshToken}" }) {
            accessToken
          }
        }
      `;
      const refreshRes = await gqlRequest(app, refreshMutation).expect(200);
      expect(refreshRes.body.errors).toBeDefined();
    });
  });

  // ─── forgotPassword ───────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('returns true for an existing email (triggers reset email)', async () => {
      // Arrange
      const mutation = `
        mutation {
          forgotPassword(input: { email: "user@example.com" })
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.forgotPassword).toBe(true);
    });

    it('returns true for a non-existent email (no user enumeration)', async () => {
      // Arrange — this email does not exist in the database
      const mutation = `
        mutation {
          forgotPassword(input: { email: "ghost@nobody.com" })
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert — same success response regardless of whether the email exists
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.forgotPassword).toBe(true);
    });
  });

  // ─── resetPassword ────────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    let jwtService: JwtService;
    let validToken: string;
    const RESET_USER_ID = 'reset_test_user';

    beforeAll(async () => {
      jwtService = app.get(JwtService);

      // Create a dedicated user so password changes don't affect other tests
      const salt = await genSalt();
      const hashedPw = await hash('Reset@123', salt);
      await prisma.user.create({
        data: {
          id: RESET_USER_ID,
          email: 'resettest@example.com',
          password: hashedPw,
          name: 'Reset Test User',
        },
      });

      // Pre-generate a valid reset token and store its hash in the DB
      validToken = await jwtService.signAsync(
        { sub: RESET_USER_ID, purpose: 'password-reset' },
        {
          secret: process.env.JWT_RESET_SECRET,
          audience: process.env.JWT_TOKEN_AUDIENCE,
          issuer: process.env.JWT_TOKEN_ISSUER,
          expiresIn: 900,
        },
      );
      const tokenHash = createHash('sha256').update(validToken).digest('hex');
      await prisma.user.update({
        where: { id: RESET_USER_ID },
        data: {
          passwordResetToken: tokenHash,
          passwordResetTokenExp: new Date(Date.now() + 900 * 1000),
        },
      });
    });

    it('succeeds with a valid, unexpired reset token', async () => {
      // Arrange
      const mutation = `
        mutation {
          resetPassword(input: { resetToken: "${validToken}", newPassword: "NewPass@1" })
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.resetPassword).toBe(true);

      // Confirm the token was cleared from the DB (one-time use)
      const user = await prisma.user.findUnique({ where: { id: RESET_USER_ID } });
      expect(user?.passwordResetToken).toBeNull();
    });

    it('revokes every refresh token of the user on reset', async () => {
      const signIn = await gqlRequest(
        app,
        `mutation { signIn(input: { email: "resettest@example.com", password: "NewPass@1" }) { refreshToken } }`,
      ).expect(200);
      expect(signIn.body.errors).toBeUndefined();
      const resetToken = await jwtService.signAsync(
        { sub: RESET_USER_ID, purpose: 'password-reset' },
        {
          secret: process.env.JWT_RESET_SECRET,
          audience: process.env.JWT_TOKEN_AUDIENCE,
          issuer: process.env.JWT_TOKEN_ISSUER,
          expiresIn: 900,
          jwtid: 'reset-revokes-sessions',
        },
      );
      await prisma.user.update({
        where: { id: RESET_USER_ID },
        data: {
          passwordResetToken: createHash('sha256').update(resetToken).digest('hex'),
          passwordResetTokenExp: new Date(Date.now() + 900 * 1000),
        },
      });

      const reset = await gqlRequest(
        app,
        `mutation { resetPassword(input: { resetToken: "${resetToken}", newPassword: "Revoked@123" }) }`,
      ).expect(200);
      expect(reset.body.errors).toBeUndefined();

      expect(await prisma.refreshToken.count({ where: { userId: RESET_USER_ID, revoked: false } })).toBe(0);
    });

    it('fails with an already-used token (cleared after first reset)', async () => {
      // Arrange — validToken was consumed by the previous test
      const mutation = `
        mutation {
          resetPassword(input: { resetToken: "${validToken}", newPassword: "AnotherPass@1" })
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });

    it('fails with an expired reset token', async () => {
      // Arrange — sign a token with a negative TTL (already past expiry)
      const expiredToken = await jwtService.signAsync(
        { sub: RESET_USER_ID, purpose: 'password-reset' },
        {
          secret: process.env.JWT_RESET_SECRET,
          audience: process.env.JWT_TOKEN_AUDIENCE,
          issuer: process.env.JWT_TOKEN_ISSUER,
          expiresIn: -1,
        },
      );
      const mutation = `
        mutation {
          resetPassword(input: { resetToken: "${expiredToken}", newPassword: "Expired@1" })
        }
      `;

      // Act
      const res = await gqlRequest(app, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeDefined();
      expect(res.body.errors[0].message).toMatch(/invalid or expired/i);
    });
  });

  // ─── Social login account linking (provider HTTP mocked) ─────────────────────

  describe('social login account linking', () => {
    let fetchMock: jest.SpyInstance;
    const GOOGLE_SIGN_IN = `
      mutation Google($input: SocialLoginInput!) {
        signInWithGoogle(input: $input) {
          accessToken
          refreshToken
        }
      }
    `;

    const googleVouchesFor = (sub: string, email: string) =>
      fetchMock.mockImplementation((url: URL) => {
        const body =
          url.hostname === 'oauth2.googleapis.com'
            ? { sub, aud: process.env.GOOGLE_CLIENT_ID }
            : { sub, email, email_verified: true };
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      });

    beforeEach(() => {
      fetchMock = jest.spyOn(global, 'fetch');
    });

    afterEach(() => fetchMock.mockRestore());

    it('does not let a Google sign-in enter an account someone pre-registered with that email', async () => {
      await signUpUser(app, { name: 'Attacker', email: 'victim@gmail.com', password: 'Password@1' });
      googleVouchesFor('google-victim', 'victim@gmail.com');

      const res = await gqlRequest(app, GOOGLE_SIGN_IN, { input: { token: 'victim-google-token' } }).expect(200);

      expect(res.body.data).toBeNull();
      expect(res.body.errors[0].extensions.code).toBe('CONFLICT');
      expect(res.body.errors[0].message).toMatch(/sign in with your email and password/i);
      expect(await prisma.authProvider.count({ where: { providerId: 'google-victim' } })).toBe(0);
    });

    it('creates and links a new account for a Google user with no existing account', async () => {
      googleVouchesFor('google-newcomer', 'newcomer@gmail.com');

      const res = await gqlRequest(app, GOOGLE_SIGN_IN, { input: { token: 'newcomer-google-token' } }).expect(200);

      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.signInWithGoogle.refreshToken).toEqual(expect.any(String));
      const link = await prisma.authProvider.findUniqueOrThrow({
        where: { providerId: 'google-newcomer' },
        include: { user: true },
      });
      expect(link.user.email).toBe('newcomer@gmail.com');

      const again = await gqlRequest(app, GOOGLE_SIGN_IN, { input: { token: 'newcomer-google-token' } }).expect(200);
      expect(again.body.errors).toBeUndefined();
    });
  });

  // ─── Social login (mocked providers) ─────────────────────────────────────────

  describe('signInWithGoogle', () => {
    let mockApp: INestApplication;

    beforeAll(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(GqlThrottlerGuard)
        .useValue({ canActivate: () => true })
        .overrideProvider(GoogleAuthenticationService)
        .useValue({
          authenticate: jest.fn().mockResolvedValue({
            accessToken: 'mock-google-access-token',
            refreshToken: 'mock-google-refresh-token',
          }),
        })
        .compile();

      mockApp = moduleFixture.createNestApplication();
      const logger = moduleFixture.get<LoggerService>(LoggerService);
      mockApp.useLogger(logger);
      mockApp.useGlobalFilters(new AllExceptionsFilter(logger));
      mockApp.useGlobalPipes(createValidationPipe());
      await mockApp.init();
    });

    afterAll(() => mockApp.close());

    it('returns a token pair for a valid Google ID token', async () => {
      // Arrange
      const mutation = `
        mutation {
          signInWithGoogle(input: { token: "google-id-token" }) {
            accessToken
            refreshToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(mockApp, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.signInWithGoogle.accessToken).toBeDefined();
      expect(res.body.data.signInWithGoogle.refreshToken).toBeDefined();
    });
  });

  describe('signInWithFacebook', () => {
    let mockApp: INestApplication;

    beforeAll(async () => {
      const moduleFixture = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(GqlThrottlerGuard)
        .useValue({ canActivate: () => true })
        .overrideProvider(FacebookAuthenticationService)
        .useValue({
          authenticate: jest.fn().mockResolvedValue({
            accessToken: 'mock-fb-access-token',
            refreshToken: 'mock-fb-refresh-token',
          }),
        })
        .compile();

      mockApp = moduleFixture.createNestApplication();
      const logger = moduleFixture.get<LoggerService>(LoggerService);
      mockApp.useLogger(logger);
      mockApp.useGlobalFilters(new AllExceptionsFilter(logger));
      mockApp.useGlobalPipes(createValidationPipe());
      await mockApp.init();
    });

    afterAll(() => mockApp.close());

    it('returns a token pair for a valid Facebook access token', async () => {
      // Arrange
      const mutation = `
        mutation {
          signInWithFacebook(input: { token: "facebook-access-token" }) {
            accessToken
            refreshToken
          }
        }
      `;

      // Act
      const res = await gqlRequest(mockApp, mutation).expect(200);

      // Assert
      expect(res.body.errors).toBeUndefined();
      expect(res.body.data.signInWithFacebook.accessToken).toBeDefined();
      expect(res.body.data.signInWithFacebook.refreshToken).toBeDefined();
    });
  });
});
