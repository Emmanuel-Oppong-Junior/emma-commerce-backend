import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus } from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { LoggerService } from '../logger.service';
import { classifyError, describeErrorForLog, stackForLog } from './error-classification';
import { reportError } from '../../observability/error-reporting';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { status, code, message } = classifyError(exception);
    const stack = stackForLog(exception);
    // Client errors (4xx: validation, auth, not found, conflict) are expected; only server failures are tracked.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) reportError(exception);

    if (host.getType<'graphql' | 'http'>() === 'graphql') {
      const gqlHost = GqlArgumentsHost.create(host);
      const info = gqlHost.getInfo();
      this.logger.error(
        `GraphQL Error: ${describeErrorForLog(exception)} | Path: ${info?.path?.key}`,
        stack,
        'ExceptionFilter',
      );
      throw new GraphQLError(message, {
        extensions: { code, status },
      });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.error(
      `Error: ${describeErrorForLog(exception)} | Status: ${status} | Path: ${request?.path}`,
      stack,
      'ExceptionFilter',
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
    });
  }
}
