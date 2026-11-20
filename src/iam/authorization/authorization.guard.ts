import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getRequest } from '../../commons/request-context';
import { Permission } from './permissions';
import { CUSTOMER_ONLY_KEY, PERMISSIONS_KEY } from './policy.decorators';

/** Enforces @RequirePermission and @CustomerOnly after AuthenticationGuard has loaded the user and their access. */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const permissions = this.reflector.getAllAndOverride<Permission[] | undefined>(PERMISSIONS_KEY, targets);
    const customerOnly = this.reflector.getAllAndOverride<boolean | undefined>(CUSTOMER_ONLY_KEY, targets);
    if (!permissions?.length && !customerOnly) return true;

    const { user, access } = getRequest(context);
    if (!user || !access) return false;
    if (customerOnly && access.roleKey) {
      throw new ForbiddenException('Staff accounts cannot use customer self-service operations');
    }
    return (permissions ?? []).every((permission) => access.permissions.has(permission));
  }
}
