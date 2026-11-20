import * as Sentry from '@sentry/nestjs';
import type { Event } from '@sentry/nestjs';
import { ArgumentsHost, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Job } from 'bullmq';
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/client';
import { runWithCorrelation } from '../commons/correlation';
import { AllExceptionsFilter } from '../commons/filters/all-exceptions.filter';
import { formatError } from '../commons/error-formatters/grapqhl-error.formatter';
import { LoggerService } from '../commons/logger.service';
import { initSentry, scrubEvent, sentryOptions } from './sentry';
import { reportFailedJob } from './error-reporting';

const DSN = 'https://public@o0.ingest.sentry.io/1';
const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;

function parseEvent(body: string | Uint8Array): Event {
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body);
  const [, itemHeader, payload] = text.split('\n');
  expect(JSON.parse(itemHeader).type).toBe('event');
  return JSON.parse(payload) as Event;
}

function httpHost(request: object): ArgumentsHost {
  const response = { status: () => response, json: () => response };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
  } as unknown as ArgumentsHost;
}

const signedInRequest = () => ({
  path: '/payment/initialize',
  url: '/payment/initialize?email=kwame@test.local',
  headers: { authorization: 'Bearer secret-access-token', cookie: 'session=abc' },
  body: { email: 'kwame@test.local', password: 'Sup3rSecret!' },
  user: { id: 'user-1', email: 'kwame@test.local' },
});

describe('Sentry without SENTRY_DSN', () => {
  it('does not initialise, so nothing is ever sent (local, test, CI)', () => {
    expect(sentryOptions({ NODE_ENV: 'production' })).toBeUndefined();
    expect(initSentry({ NODE_ENV: 'production' })).toBe(false);
    expect(Sentry.isInitialized()).toBe(false);
  });
});

describe('Sentry options', () => {
  it('take environment and release from env, default the environment to NODE_ENV and tracing to 0', () => {
    expect(sentryOptions({ SENTRY_DSN: DSN, NODE_ENV: 'production' })).toMatchObject({
      dsn: DSN,
      environment: 'production',
      tracesSampleRate: 0,
      dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    });
    expect(
      sentryOptions({
        SENTRY_DSN: DSN,
        NODE_ENV: 'production',
        SENTRY_ENVIRONMENT: 'staging',
        SENTRY_RELEASE: 'emma-commerce@1.2.3',
        SENTRY_TRACES_SAMPLE_RATE: '0.25',
      }),
    ).toMatchObject({ environment: 'staging', release: 'emma-commerce@1.2.3', tracesSampleRate: 0.25 });
  });
});

describe('scrubEvent', () => {
  it('keeps only method and path of the request, the user id, and drops breadcrumbs', () => {
    const event: Event = {
      request: {
        method: 'POST',
        url: 'https://api.test/graphql?token=abc',
        headers: { authorization: 'Bearer x' },
        cookies: { session: 'abc' },
        data: { email: 'kwame@test.local' },
        query_string: 'token=abc',
      },
      user: { id: 'user-1', email: 'kwame@test.local', ip_address: '10.0.0.1' },
      breadcrumbs: [{ message: 'GET /orders?email=kwame@test.local' }],
    };

    expect(scrubEvent(event, {})).toEqual({
      request: { method: 'POST', url: 'https://api.test/graphql' },
      user: { id: 'user-1' },
    });
  });

  it("replaces a Prisma error's message, which can quote the values written", () => {
    const error = new Prisma.PrismaClientKnownRequestError('Failed for data { email: "kwame@test.local" }', {
      code: 'P2034',
      clientVersion: 'test',
    });
    const event: Event = { exception: { values: [{ type: 'Error', value: error.message }] } };

    expect(scrubEvent(event, { originalException: error }).exception?.values?.[0].value).toBe('Prisma error P2034');
  });
});

describe('Sentry error reporting (fake transport)', () => {
  const sent: Event[] = [];

  const reported = async () => {
    await Sentry.flush(2_000);
    return sent.splice(0);
  };

  beforeAll(() => {
    Sentry.init({
      ...sentryOptions({ SENTRY_DSN: DSN, NODE_ENV: 'test' }),
      defaultIntegrations: false,
      integrations: [],
      enableRuntimeChannelInjection: false,
      transport: (options) =>
        Sentry.createTransport(options, async (request) => {
          sent.push(parseEvent(request.body));
          return { statusCode: 200 };
        }),
    });
  });

  afterAll(() => Sentry.close());

  it('reports an internal error from an HTTP request with its request id and only the user id', async () => {
    const request = signedInRequest();

    runWithCorrelation({ requestId: 'req-1', request }, () =>
      new AllExceptionsFilter(logger).catch(new Error('database connection exploded'), httpHost(request)),
    );

    const [event, ...others] = await reported();
    expect(others).toHaveLength(0);
    expect(event.tags).toMatchObject({ requestId: 'req-1' });
    expect(event.user).toEqual({ id: 'user-1' });
    expect(event.exception?.values?.[0].value).toBe('database connection exploded');
    const raw = JSON.stringify(event);
    ['kwame@test.local', 'secret-access-token', 'Sup3rSecret!', 'session=abc'].forEach((pii) =>
      expect(raw).not.toContain(pii),
    );
  });

  it.each([
    ['400 bad request', new BadRequestException('Invalid quantity')],
    ['403 forbidden', new ForbiddenException()],
    ['404 not found', new NotFoundException('Order not found')],
  ])('does not report an expected client error (%s)', async (_case, exception) => {
    new AllExceptionsFilter(logger).catch(exception, httpHost(signedInRequest()));

    await expect(reported()).resolves.toHaveLength(0);
  });

  it('reports an unclassified GraphQL error (a field resolver failure) but not a client error', async () => {
    const format = formatError(logger);
    const fieldFailure = new GraphQLError('Cannot read properties of undefined', {
      originalError: new TypeError('Cannot read properties of undefined'),
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    });

    runWithCorrelation({ requestId: 'req-2' }, () => {
      format({ message: fieldFailure.message, extensions: fieldFailure.extensions }, fieldFailure);
      format({ message: 'Bad input', extensions: { code: 'BAD_USER_INPUT' } }, new GraphQLError('Bad input'));
      format({ message: 'Not signed in', extensions: { code: 'UNAUTHENTICATED' } }, new GraphQLError('x'));
    });

    const events = await reported();
    expect(events).toHaveLength(1);
    expect(events[0].tags).toMatchObject({ requestId: 'req-2' });
    expect(events[0].exception?.values?.[0].type).toBe('TypeError');
  });

  it('does not report a GraphQL error the exception filter already classified (it carries a status)', async () => {
    formatError(logger)(
      { message: 'Internal server error', extensions: { code: 'INTERNAL_SERVER_ERROR', status: 500 } },
      new GraphQLError('x'),
    );

    await expect(reported()).resolves.toHaveLength(0);
  });

  it('reports a job once it has no attempts left, tagged with job id, queue and originating request', async () => {
    const job = (attemptsMade: number) =>
      ({
        id: 'job-1',
        name: 'paystack.webhook.v1',
        queueName: 'webhooks',
        attemptsMade,
        opts: { attempts: 3 },
        data: { webhookEventId: 'evt-1', meta: { requestId: 'req-3' } },
      }) as unknown as Job;

    reportFailedJob(job(1), new Error('Paystack unreachable'));
    reportFailedJob(job(3), new Error('Paystack unreachable'));

    const events = await reported();
    expect(events).toHaveLength(1);
    expect(events[0].tags).toMatchObject({
      requestId: 'req-3',
      jobId: 'job-1',
      queue: 'webhooks',
      jobName: 'paystack.webhook.v1',
    });
  });
});
