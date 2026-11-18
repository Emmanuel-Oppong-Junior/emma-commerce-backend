import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { lastValueFrom, of, throwError } from 'rxjs';
import { Prisma } from '../../generated/prisma/client';
import { GraphqlLoggingInterceptor } from './graphql-logging.interceptor';
import { LoggerService } from '../logger.service';
import { httpContext } from '../../../test/helpers/execution-context.helper';

const SECRETS = ['refresh-token-value', 'reset-token-value', 'Sup3rSecret!', 'kwame@test.local', 'Bearer access-token'];

function graphqlCall(body: object) {
  const req = { headers: { authorization: 'Bearer access-token' }, body, user: { id: 'user-1' } };
  const info = { operation: { operation: 'mutation', name: { value: 'Refresh' } }, fieldName: 'refreshToken' };
  const context = new ExecutionContextHost([{}, {}, { req }, info]);
  context.setType('graphql');
  return context;
}

describe('GraphqlLoggingInterceptor', () => {
  const logger = { log: jest.fn(), error: jest.fn() };
  const interceptor = new GraphqlLoggingInterceptor(logger as unknown as LoggerService);
  const body = {
    query: 'mutation Refresh($input: RefreshTokenInput!) { refreshToken(input: $input) { accessToken } }',
    variables: {
      input: { refreshToken: 'refresh-token-value', resetToken: 'reset-token-value', newPassword: 'Sup3rSecret!' },
      contact: { email: 'kwame@test.local' },
    },
  };

  beforeEach(() => jest.resetAllMocks());

  it('passes HTTP requests straight to the handler without logging them', async () => {
    const context = httpContext({ headers: {}, body: { event: 'charge.success' } });

    await expect(lastValueFrom(interceptor.intercept(context, { handle: () => of('handled') }))).resolves.toBe(
      'handled',
    );
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs the operation, root field and variable keys without any value or header', async () => {
    await lastValueFrom(interceptor.intercept(graphqlCall(body), { handle: () => of('ok') }));

    const [line, context] = logger.log.mock.calls[0];
    expect(context).toBe('GraphQL');
    expect(line).toContain('mutation Refresh > refreshToken');
    expect(line).toContain('"refreshToken":"[redacted]"');
    expect(line).toContain('user:user-1');
    SECRETS.forEach((secret) => expect(line).not.toContain(secret));
    expect(line).not.toContain('accessToken }');
  });

  it('logs a failing Prisma call by code only, never its raw message', async () => {
    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed: data: { email: "kwame@test.local" }',
      { code: 'P2002', clientVersion: 'test', meta: { modelName: 'User', target: ['email'] } },
    );

    await expect(
      lastValueFrom(interceptor.intercept(graphqlCall(body), { handle: () => throwError(() => prismaError) })),
    ).rejects.toBe(prismaError);

    const [line] = logger.error.mock.calls[0];
    expect(line).toContain('Error: Prisma P2002 on User.email');
    SECRETS.forEach((secret) => expect(line).not.toContain(secret));
  });
});
