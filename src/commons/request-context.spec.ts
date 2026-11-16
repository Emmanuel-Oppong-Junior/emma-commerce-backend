import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { getRequest } from './request-context';

describe('getRequest', () => {
  const request = { headers: { authorization: 'Bearer t' } };

  it('returns the Express request for an HTTP context', () => {
    const context = new ExecutionContextHost([request, {}, () => undefined]);
    context.setType('http');

    expect(getRequest(context)).toBe(request);
  });

  it('returns the request from the GraphQL context', () => {
    const context = new ExecutionContextHost([{}, {}, { req: request }, {}]);
    context.setType('graphql');

    expect(getRequest(context)).toBe(request);
  });

  it('rejects other context types instead of returning undefined', () => {
    const context = new ExecutionContextHost([{}]);
    context.setType('rpc');

    expect(() => getRequest(context)).toThrow('Unsupported execution context type: "rpc"');
  });
});
