import { INestApplication } from '@nestjs/common';
import { gqlRequest } from './graphql.helper';
import { PrismaService } from '../../src/prisma/prisma.service';
import { base32Decode, totp } from '../../src/iam/mfa/totp';
import { TEST_TOTP_SEED } from './staff.helper';

/** Credentials used for the seeded regular user (mirrors `seedMinimal`). */
const USER_CREDENTIALS = { email: 'user@example.com', password: 'User@123' };

/** Credentials used for the seeded admin (mirrors `seedMinimal`). */
const ADMIN_CREDENTIALS = { email: 'admin@example.com', password: 'Admin@123' };

/** Credentials used for the seeded super admin (mirrors `seedMinimal`). */
const SUPER_ADMIN_CREDENTIALS = { email: 'super_admin@example.com', password: 'SuperAdmin@123' };

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SignUpInput {
  email: string;
  password: string;
  name: string;
  phoneNumber?: string;
}

/**
 * Signs up a new user via the `signUp` GraphQL mutation and returns the auth tokens.
 *
 * @param app - The bootstrapped NestJS test application.
 * @param input - Registration payload (email, password, name, optional phoneNumber).
 */
export async function signUpUser(app: INestApplication, input: SignUpInput): Promise<AuthTokens> {
  const mutation = `
    mutation SignUp($input: SignUpInput!) {
      signUp(input: $input) {
        accessToken
        refreshToken
      }
    }
  `;

  const response = await gqlRequest(app, mutation, { input }).expect(200);
  return response.body.data.signUp as AuthTokens;
}

/** The current authenticator code of a user enrolled by prepareStaffAccounts. */
export function testTotpCode(): string {
  return totp(base32Decode(TEST_TOTP_SEED), Date.now());
}

/**
 * Lets the next code be accepted again. The server refuses a TOTP code whose 30-second step was already used, and
 * tests sign the same staff user in several times within one step.
 */
export async function allowTotpReuse(app: INestApplication, email: string): Promise<void> {
  await app.get(PrismaService).user.update({ where: { email }, data: { mfaLastUsedStep: null } });
}

/**
 * Signs in with email and password and, when the account has two-factor authentication (staff enrolled by
 * prepareStaffAccounts), completes the sign-in with a code, as the frontend does. The session is then freshly
 * verified, so step-up actions work for 10 minutes.
 */
export async function signInWithPassword(app: INestApplication, email: string, password: string): Promise<AuthTokens> {
  const signIn = await gqlRequest(
    app,
    'mutation SignIn($input: SignInInput!) { signIn(input: $input) { accessToken refreshToken } }',
    { input: { email, password } },
  ).expect(200);
  if (!signIn.body.errors) return signIn.body.data.signIn as AuthTokens;
  const [error] = signIn.body.errors;
  // Apps built without AllExceptionsFilter (test/e2e.utils.ts) leave the extensions under originalError.
  const extensions = error.extensions?.reason ? error.extensions : error.extensions?.originalError?.extensions;
  if (extensions?.reason !== 'MFA_REQUIRED') throw new Error(`signIn failed for ${email}: ${error.message}`);

  await allowTotpReuse(app, email);
  const completed = await gqlRequest(
    app,
    'mutation Complete($input: CompleteMfaSignInInput!) { completeMfaSignIn(input: $input) { accessToken refreshToken } }',
    { input: { challenge: extensions.mfaChallenge, code: testTotpCode() } },
  ).expect(200);
  if (completed.body.errors)
    throw new Error(`completeMfaSignIn failed for ${email}: ${completed.body.errors[0].message}`);
  return completed.body.data.completeMfaSignIn as AuthTokens;
}

/**
 * Signs in the seeded regular user and returns the access token.
 * Requires the database to contain the user created by `seedMinimal`.
 *
 * @param app - The bootstrapped NestJS test application.
 */
export async function signInUser(app: INestApplication): Promise<string> {
  const mutation = `
    mutation {
      signIn(input: { email: "${USER_CREDENTIALS.email}", password: "${USER_CREDENTIALS.password}" }) {
        accessToken
      }
    }
  `;

  const response = await gqlRequest(app, mutation).expect(200);
  return response.body.data.signIn.accessToken as string;
}

/**
 * Signs in the seeded admin and returns the access token.
 * Requires the database to contain the admin created by `seedMinimal`.
 *
 * @param app - The bootstrapped NestJS test application.
 */
export async function signInAdmin(app: INestApplication): Promise<string> {
  return (await signInWithPassword(app, ADMIN_CREDENTIALS.email, ADMIN_CREDENTIALS.password)).accessToken;
}

/**
 * Signs in the seeded super admin and returns the access token.
 * Requires the database to contain the super admin created by `seedMinimal`.
 *
 * @param app - The bootstrapped NestJS test application.
 */
export async function signInSuperAdmin(app: INestApplication): Promise<string> {
  return (await signInWithPassword(app, SUPER_ADMIN_CREDENTIALS.email, SUPER_ADMIN_CREDENTIALS.password)).accessToken;
}

/**
 * Builds an `Authorization` header object from a JWT access token.
 * Intended for use with `gqlRequest`:
 *   `gqlRequest(app, query, vars, token)` — or for supertest `.set()` calls directly.
 *
 * @param token - A valid JWT access token.
 * @returns An object with the `Authorization: Bearer <token>` header.
 */
export function getAuthHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
