import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Permission } from './permissions';
import { getRequest } from '../../commons/request-context';
import { CUSTOMER_ACCESS, StaffAccess } from './staff-access';

export const PERMISSIONS_KEY = 'requiredPermissions';
export const CUSTOMER_ONLY_KEY = 'customerOnly';

/** The signed-in user needs every listed permission. Implies a Bearer token. */
export const RequirePermission = (...permissions: [Permission, ...Permission[]]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/** Self-service operations staff accounts may not use (ordering, paying, reviewing as a customer). */
export const CustomerOnly = () => SetMetadata(CUSTOMER_ONLY_KEY, true);

export function activeAccessFactory(_data: unknown, context: ExecutionContext): StaffAccess {
  return getRequest(context).access ?? CUSTOMER_ACCESS;
}

/** The signed-in user's staff role and permissions, as loaded by the access-token guard. */
export const ActiveAccess = createParamDecorator(activeAccessFactory);
