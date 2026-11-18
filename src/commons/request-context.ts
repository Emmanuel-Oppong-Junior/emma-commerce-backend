import { ExecutionContext } from '@nestjs/common';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { User } from '../generated/prisma/client';
import { Request } from 'express';

export type AuthenticatedRequest = Request & { user?: User };

export function getRequest(context: ExecutionContext): AuthenticatedRequest {
  const type = context.getType<GqlContextType>();
  if (type === 'graphql') return GqlExecutionContext.create(context).getContext().req;
  if (type === 'http') return context.switchToHttp().getRequest();
  throw new Error(`Unsupported execution context type: "${type}"`);
}
