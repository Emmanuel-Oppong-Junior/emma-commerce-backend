import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { LoggerService } from '../logger.service';
import { GqlContextType, GqlExecutionContext } from '@nestjs/graphql';
import { sanitizeVariables } from '../useful-functions';
import { describeErrorForLog } from '../filters/error-classification';

@Injectable()
export class GraphqlLoggingInterceptor implements NestInterceptor {
  constructor(private readonly logger: LoggerService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Registered globally, so REST requests reach it too; LoggerMiddleware already logs those.
    if (context.getType<GqlContextType>() !== 'graphql') return next.handle();
    const start = Date.now();
    const gqlContext = GqlExecutionContext.create(context);
    const { req } = gqlContext.getContext();
    const info = gqlContext.getInfo();

    const operationType = info.operation?.operation;
    const operationName = info.operation?.name?.value || 'Unnamed';
    // Never the query text or variable values: both can carry tokens, passwords and PII.
    const variables = JSON.stringify(sanitizeVariables(req?.body?.variables ?? {}));
    const summary = `${operationType} ${operationName} > ${info.fieldName} | Variables: ${variables}`;

    const correlationId = req?.correlationId ?? req?.headers?.['x-request-id'] ?? '-';
    const userId = req?.user?.id ?? 'anonymous';

    return next.handle().pipe(
      tap({
        next: () => {
          const duration = Date.now() - start;
          this.logger.log(
            `${summary} | Status: 200 | ${duration}ms | user:${userId} | cid:${correlationId}`,
            'GraphQL',
          );
        },
        error: (error) => {
          const duration = Date.now() - start;
          this.logger.error(
            `${summary} failed | Error: ${describeErrorForLog(error)} | ${duration}ms | user:${userId} | cid:${correlationId}`,
            error?.stack,
            'GraphQL',
          );
        },
      }),
    );
  }
}
