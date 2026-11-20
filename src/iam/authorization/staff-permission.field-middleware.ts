import { ForbiddenException } from '@nestjs/common';
import { FieldMiddleware } from '@nestjs/graphql';
import { AuthenticatedRequest } from '../../commons/request-context';
import { Permission } from './permissions';
import { hasPermission } from './staff-access';

// Guards do not run on fields (no fieldResolverEnhancers), so this reads the access the root guard attached.
/** Lets only staff holding `permission` read the field. */
export function staffWith(permission: Permission): FieldMiddleware<unknown, { req?: AuthenticatedRequest }> {
  return ({ context, info }, next) => {
    if (hasPermission(context.req?.access, permission)) return next();
    throw new ForbiddenException(`Not allowed to read ${info?.parentType.name}.${info?.fieldName}`);
  };
}
