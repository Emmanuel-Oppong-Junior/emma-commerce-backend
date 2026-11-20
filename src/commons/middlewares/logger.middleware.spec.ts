import { EventEmitter } from 'node:events';
import { LoggerMiddleware } from './logger.middleware';
import { LoggerService } from '../logger.service';
import { currentCorrelation } from '../correlation';

function buildRequest(headers: Record<string, unknown> = {}) {
  return { headers, method: 'GET', originalUrl: '/graphql?query={me{email}}&variables={"token":"t"}' } as never;
}

function buildResponse() {
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  });
  return response;
}

describe('LoggerMiddleware', () => {
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const middleware = new LoggerMiddleware(logger as unknown as LoggerService);

  beforeEach(() => jest.resetAllMocks());

  it('should be defined', () => {
    const mockLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as LoggerService;
    expect(new LoggerMiddleware(mockLogger)).toBeDefined();
  });

  it('keeps a well-formed client X-Request-ID, echoes it and runs the request in its context', () => {
    const response = buildResponse();
    let seen: unknown;

    middleware.use(buildRequest({ 'x-request-id': 'client-id-1' }), response as never, () => {
      seen = currentCorrelation();
    });

    expect(response.headers['X-Request-ID']).toBe('client-id-1');
    expect(seen).toEqual({ requestId: 'client-id-1' });
  });

  it('replaces a malformed client id instead of echoing it (header injection, log forging)', () => {
    const response = buildResponse();
    let seen: string | undefined;

    middleware.use(buildRequest({ 'x-request-id': 'bad id\r\nSet-Cookie: x' }), response as never, () => {
      seen = currentCorrelation()?.requestId;
    });

    expect(response.headers['X-Request-ID']).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen).toBe(response.headers['X-Request-ID']);
  });

  it('logs one structured line per request, without the query string', () => {
    const response = buildResponse();
    const request = buildRequest({ 'x-request-id': 'rid-1' }) as unknown as { user?: { id: string } };

    middleware.use(request as never, response as never, () => undefined);
    request.user = { id: 'user-1' };
    response.emit('finish');

    expect(logger.log).toHaveBeenCalledTimes(1);
    const [message, context, fields] = logger.log.mock.calls[0];
    expect(context).toBe('HTTP');
    expect(message).toMatch(/^GET \/graphql 200 \d+ms$/);
    expect(fields).toMatchObject({
      requestId: 'rid-1',
      userId: 'user-1',
      method: 'GET',
      path: '/graphql',
      status: 200,
    });
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('token');
  });
});
