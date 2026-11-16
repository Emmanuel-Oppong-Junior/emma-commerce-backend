import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { REQUEST_USER_KEY } from '../../iam.constants';
import { getRequest } from '../../../commons/request-context';

export function activeUserFactory(field: string | undefined, context: ExecutionContext) {
  const user = getRequest(context)[REQUEST_USER_KEY];
  return field ? user?.[field as keyof typeof user] : user;
}

export const ActiveUser = createParamDecorator(activeUserFactory);
