import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { ThrottlerGuard } from '@nestjs/throttler';

// Internal metadata key prefixes from @nestjs/throttler (stable across v5/v6)
const THROTTLER_LIMIT = 'THROTTLER:LIMIT';
const THROTTLER_TTL = 'THROTTLER:TTL';
const THROTTLER_BLOCK_DURATION = 'THROTTLER:BLOCK_DURATION';
const THROTTLER_TRACKER = 'THROTTLER:TRACKER';
const THROTTLER_KEY_GENERATOR = 'THROTTLER:KEY_GENERATOR';
const THROTTLER_SKIP = 'THROTTLER:SKIP';

@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  getRequestResponse(context: ExecutionContext) {
    if (context.getType<'graphql' | 'http'>() === 'graphql') {
      const gqlCtx = GqlExecutionContext.create(context);
      const ctx = gqlCtx.getContext<{ req: Request; res: Response }>();
      return { req: ctx.req, res: ctx.res };
    }
    const http = context.switchToHttp();
    return { req: http.getRequest(), res: http.getResponse() };
  }

  /**
   * Overrides canActivate to make named throttlers (auth, payment, etc.) opt-in.
   * By default only the 'global' throttler applies. A route must explicitly opt in
   * to a named throttler via @Throttle({ name: { limit, ttl } }) for it to take effect.
   * This prevents restrictive throttlers (e.g. passwordReset: 3/hr) from accidentally
   * rate-limiting unrelated routes like product queries.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const classRef = context.getClass();

    if (await this.shouldSkip(context)) {
      return true;
    }

    const continues: boolean[] = [];

    for (const namedThrottler of this.throttlers) {
      // Non-global throttlers are opt-in: only apply when the route explicitly
      // sets a limit via @Throttle({ [name]: { limit, ttl } }).
      if (namedThrottler.name !== 'global') {
        const hasExplicitLimit = this.reflector.getAllAndOverride<number | undefined>(
          THROTTLER_LIMIT + namedThrottler.name,
          [handler, classRef],
        );
        if (hasExplicitLimit === undefined) {
          continues.push(true);
          continue;
        }
      }

      const skip = this.reflector.getAllAndOverride<boolean>(THROTTLER_SKIP + namedThrottler.name, [handler, classRef]);
      const skipIf = namedThrottler.skipIf ?? this.commonOptions.skipIf;
      if (skip || skipIf?.(context)) {
        continues.push(true);
        continue;
      }

      const routeOrClassLimit = this.reflector.getAllAndOverride<number>(THROTTLER_LIMIT + namedThrottler.name, [
        handler,
        classRef,
      ]);
      const routeOrClassTtl = this.reflector.getAllAndOverride<number>(THROTTLER_TTL + namedThrottler.name, [
        handler,
        classRef,
      ]);
      const routeOrClassBlockDuration = this.reflector.getAllAndOverride<number>(
        THROTTLER_BLOCK_DURATION + namedThrottler.name,
        [handler, classRef],
      );
      const routeOrClassGetTracker = this.reflector.getAllAndOverride(THROTTLER_TRACKER + namedThrottler.name, [
        handler,
        classRef,
      ]);
      const routeOrClassGetKeyGenerator = this.reflector.getAllAndOverride(
        THROTTLER_KEY_GENERATOR + namedThrottler.name,
        [handler, classRef],
      );

      const resolve = async <T>(v: T | ((ctx: ExecutionContext) => T | Promise<T>)): Promise<T> =>
        typeof v === 'function' ? (v as (ctx: ExecutionContext) => T | Promise<T>)(context) : v;

      const limit = await resolve(routeOrClassLimit || namedThrottler.limit);
      const ttl = await resolve(routeOrClassTtl || namedThrottler.ttl);
      const blockDuration = await resolve(routeOrClassBlockDuration || namedThrottler.blockDuration || ttl);
      const getTracker = routeOrClassGetTracker || namedThrottler.getTracker || this.commonOptions.getTracker;
      const generateKey = routeOrClassGetKeyGenerator || namedThrottler.generateKey || this.commonOptions.generateKey;

      continues.push(
        await this.handleRequest({
          context,
          limit,
          ttl,
          throttler: namedThrottler,
          blockDuration,
          getTracker,
          generateKey,
        }),
      );
    }

    return continues.every((cont) => cont);
  }
}
