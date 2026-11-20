import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { LoggerService } from '../logger.service';
import { classifyError, describeErrorForLog } from './error-classification';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { status, code, message, extensions } = classifyError(exception);
    // [CRITICAL-4] Never expose stack traces outside development
    const isDev = process.env.NODE_ENV === 'development';
    const stack = isDev && exception instanceof Error ? exception.stack : undefined;

    if (host.getType<'graphql' | 'http'>() === 'graphql') {
      const gqlHost = GqlArgumentsHost.create(host);
      const info = gqlHost.getInfo();
      this.logger.error(
        `GraphQL Error: ${describeErrorForLog(exception)} | Path: ${info?.path?.key}`,
        stack,
        'ExceptionFilter',
      );
      throw new GraphQLError(message, {
        extensions: { ...extensions, code, status },
      });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.error(
      `Error: ${describeErrorForLog(exception)} | Status: ${status} | URL: ${request?.url}`,
      stack,
      'ExceptionFilter',
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      message,
      ...extensions,
    });
  }
}
