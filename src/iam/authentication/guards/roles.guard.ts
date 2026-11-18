import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../../generated/prisma/client';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { REQUEST_USER_KEY } from '../../iam.constants';
import { getRequest } from '../../../commons/request-context';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const contextRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!contextRoles) return true;
    const user = getRequest(context)[REQUEST_USER_KEY];
    return contextRoles.some((role) => user?.role === role);
  }
}
