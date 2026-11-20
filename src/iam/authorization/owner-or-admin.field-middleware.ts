import { ForbiddenException } from '@nestjs/common';
import { FieldMiddleware } from '@nestjs/graphql';
import { AuthenticatedRequest } from '../../commons/request-context';
import { hasPermission } from './staff-access';

// Guards do not run on fields (no fieldResolverEnhancers), so this reads the user and access the root guard attached.
/** Lets the owner of the record, or staff holding user.view, read the field. */
export function ownerOrAdmin<TSource>(
  ownerIdOf: (source: TSource) => string | null | undefined,
): FieldMiddleware<TSource, { req?: AuthenticatedRequest }> {
  return ({ source, context, info }, next) => {
    const viewer = context.req?.user;
    const isOwner = !!viewer && viewer.id === ownerIdOf(source);
    if (isOwner || (viewer && hasPermission(context.req?.access, 'user.view'))) return next();
    throw new ForbiddenException(`Not allowed to read ${info?.parentType.name}.${info?.fieldName}`);
  };
}
