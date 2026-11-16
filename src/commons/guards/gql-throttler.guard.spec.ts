import { Reflector } from '@nestjs/core';
import { ThrottlerStorage } from '@nestjs/throttler';
import { GqlThrottlerGuard } from './gql-throttler.guard';
import { graphqlContext, httpContext } from '../../../test/helpers/execution-context.helper';

describe('GqlThrottlerGuard', () => {
  const guard = new GqlThrottlerGuard([], {} as ThrottlerStorage, new Reflector());
  const request = { ip: '127.0.0.1', headers: {} };

  it('reads the request of an HTTP call', () => {
    expect(guard.getRequestResponse(httpContext(request)).req).toBe(request);
  });

  it('reads the request of a GraphQL call', () => {
    expect(guard.getRequestResponse(graphqlContext(request)).req).toBe(request);
  });
});
