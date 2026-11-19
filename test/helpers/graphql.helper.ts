import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';

/**
 * Sends a GraphQL request to the running test application.
 * Optionally attaches a Bearer token for authenticated operations.
 *
 * @param app - The bootstrapped NestJS test application.
 * @param query - The GraphQL query or mutation string.
 * @param variables - Optional variables map for the operation.
 * @param token - Optional JWT access token; adds `Authorization: Bearer <token>` when supplied.
 * @returns A supertest `Test` instance — call `.expect()` to assert the response.
 */
export function gqlRequest(
  app: INestApplication,
  query: string,
  variables?: Record<string, unknown>,
  token?: string,
): request.Test {
  const req = request(app.getHttpServer())
    .post('/graphql')
    .send({ query, variables })
    .set('Accept', 'application/json');

  if (token) {
    req.set('Authorization', `Bearer ${token}`);
  }

  return req;
}

/** A Money field as the API returns it. */
export interface MoneyValue {
  amount: string;
  currency: string;
}

/** The expected value of a Money field in the store currency (the test database's store is GHS). */
export function ghs(amount: string): MoneyValue {
  return { amount, currency: 'GHS' };
}
