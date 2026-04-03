import { INestApplication } from '@nestjs/common';
import { gqlRequest } from './graphql.helper';

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
  const mutation = `
    mutation {
      signIn(input: { email: "${ADMIN_CREDENTIALS.email}", password: "${ADMIN_CREDENTIALS.password}" }) {
        accessToken
      }
    }
  `;

  const response = await gqlRequest(app, mutation).expect(200);
  return response.body.data.signIn.accessToken as string;
}

/**
 * Signs in the seeded super admin and returns the access token.
 * Requires the database to contain the super admin created by `seedMinimal`.
 *
 * @param app - The bootstrapped NestJS test application.
 */
export async function signInSuperAdmin(app: INestApplication): Promise<string> {
  const mutation = `
    mutation {
      signIn(input: { email: "${SUPER_ADMIN_CREDENTIALS.email}", password: "${SUPER_ADMIN_CREDENTIALS.password}" }) {
        accessToken
      }
    }
  `;

  const response = await gqlRequest(app, mutation).expect(200);
  return response.body.data.signIn.accessToken as string;
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
