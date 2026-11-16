import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

type Handler = (...args: never[]) => unknown;
type Controller = new (...args: never[]) => object;

export class TestController {
  handle() {
    return 'handled';
  }
}

export function httpContext(
  request: object,
  handler: Handler = TestController.prototype.handle,
  cls: Controller = TestController,
) {
  const context = new ExecutionContextHost([request, {}, () => undefined], cls, handler);
  context.setType('http');
  return context;
}

export function graphqlContext(
  request: object,
  handler: Handler = TestController.prototype.handle,
  cls: Controller = TestController,
) {
  const context = new ExecutionContextHost([{}, {}, { req: request }, {}], cls, handler);
  context.setType('graphql');
  return context;
}
