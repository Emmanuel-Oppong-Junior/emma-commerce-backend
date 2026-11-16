import { ForbiddenException } from '@nestjs/common';
import { FieldMiddleware } from '@nestjs/graphql';
import { Role } from '../../users/enums/role.enum';
import { AuthenticatedRequest } from '../../commons/request-context';

const ADMIN_ROLES: string[] = [Role.ADMIN, Role.SUPER_ADMIN];

// Guards do not run on fields (no fieldResolverEnhancers), so this reads the user the root guard attached.
export function ownerOrAdmin<TSource>(
  ownerIdOf: (source: TSource) => string | null | undefined,
): FieldMiddleware<TSource, { req?: AuthenticatedRequest }> {
  return ({ source, context, info }, next) => {
    const viewer = context.req?.user;
    const isOwner = !!viewer && viewer.id === ownerIdOf(source);
    if (isOwner || (viewer && ADMIN_ROLES.includes(viewer.role))) return next();
    throw new ForbiddenException(`Not allowed to read ${info.parentType.name}.${info.fieldName}`);
  };
}
