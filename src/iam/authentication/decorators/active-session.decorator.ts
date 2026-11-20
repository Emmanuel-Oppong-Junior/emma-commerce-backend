import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { getRequest } from '../../../commons/request-context';

export function activeSessionFactory(_data: unknown, context: ExecutionContext): string | undefined {
  return getRequest(context).sessionId;
}

/** The session id (`sid` claim) of the access token; undefined for tokens issued before sessions had ids. */
export const ActiveSession = createParamDecorator(activeSessionFactory);
