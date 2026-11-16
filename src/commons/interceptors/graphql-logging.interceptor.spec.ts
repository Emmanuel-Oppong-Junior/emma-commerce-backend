import { lastValueFrom, of } from 'rxjs';
import { GraphqlLoggingInterceptor } from './graphql-logging.interceptor';
import { LoggerService } from '../logger.service';
import { graphqlContext, httpContext } from '../../../test/helpers/execution-context.helper';

describe('GraphqlLoggingInterceptor', () => {
  const logger = { log: jest.fn(), error: jest.fn() };
  const interceptor = new GraphqlLoggingInterceptor(logger as unknown as LoggerService);
  const handler = { handle: () => of('handled') };

  beforeEach(() => jest.resetAllMocks());

  it('passes HTTP requests straight to the handler without logging them', async () => {
    const context = httpContext({ headers: {}, body: { event: 'charge.success' } });

    await expect(lastValueFrom(interceptor.intercept(context, handler))).resolves.toBe('handled');
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('logs GraphQL operations', async () => {
    const context = graphqlContext({ headers: {}, body: { query: '{ products { id } }', variables: {} } });

    await expect(lastValueFrom(interceptor.intercept(context, handler))).resolves.toBe('handled');
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('products'), 'GraphQL');
  });
});
