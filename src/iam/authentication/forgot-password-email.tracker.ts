import { BadRequestException, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';

// Guards run before the ValidationPipe, so the email arrives raw and is normalised here.
export function trackForgotPasswordByEmail(_req: Record<string, unknown>, context: ExecutionContext): string {
  const email = GqlExecutionContext.create(context).getArgs<{ input?: { email?: unknown } }>().input?.email;
  if (typeof email !== 'string') {
    throw new BadRequestException(`forgotPassword expects input.email to be a string, got ${typeof email}`);
  }
  return `email:${email.trim().toLowerCase()}`;
}
