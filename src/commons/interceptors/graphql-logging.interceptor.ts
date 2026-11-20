import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { LoggerService } from '../logger.service';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { GraphQLResolveInfo } from 'graphql';
import { sanitizeVariables } from '../useful-functions';
import { describeErrorForLog, stackForLog } from '../filters/error-classification';

/** Logs each root GraphQL field (one line per operation field, not per nested field resolver). */
@Injectable()
export class GraphqlLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Registered globally, so REST requests reach it too; LoggerMiddleware already logs those.
    if (context.getType<GqlContextType>() !== 'graphql') return next.handle();
    const gqlContext = GqlExecutionContext.create(context);
    const info = gqlContext.getInfo<GraphQLResolveInfo | undefined>();
    if (info?.path?.prev) return next.handle();
    const start = Date.now();
    const req = gqlContext.getContext()?.req;

    const operationType = info?.operation?.operation;
    const operationName = info?.operation?.name?.value || 'Unnamed';
    const fieldName = info?.fieldName;
    // Never the query text or variable values: both can carry tokens, passwords and PII. A batched (array) body has no
    // top-level variables, so it logs none.
    const variables = JSON.stringify(sanitizeVariables(req?.body?.variables ?? {}));
    const summary = `${operationType} ${operationName} > ${fieldName} | Variables: ${variables}`;
    const fields = { operationType, operationName, field: fieldName };
    const userId = req?.user?.id ?? 'anonymous';

    return next.handle().pipe(
      tap({
        next: () => {
          const durationMs = Date.now() - start;
          this.logger.log(`${summary} | ok | ${durationMs}ms | user:${userId}`, 'GraphQL', { ...fields, durationMs });
        },
        error: (error) => {
          const durationMs = Date.now() - start;
          this.logger.error(
            `${summary} failed | Error: ${describeErrorForLog(error)} | ${durationMs}ms | user:${userId}`,
            stackForLog(error),
            'GraphQL',
            { ...fields, durationMs },
          );
        },
      }),
    );
  }
}
