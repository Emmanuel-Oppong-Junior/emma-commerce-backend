import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { GqlArgumentsHost } from '@nestjs/graphql';
import { Request, Response } from 'express';
import { GraphQLError } from 'graphql';
import { LoggerService } from '../logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    // [CRITICAL-4] Never expose stack traces outside development
    const isDev = process.env.NODE_ENV === 'development';
    const stack = isDev && exception instanceof Error ? exception.stack : undefined;

    if (host.getType<'graphql' | 'http'>() === 'graphql') {
      const gqlHost = GqlArgumentsHost.create(host);
      const info = gqlHost.getInfo();
      const originalMessage = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`GraphQL Error: ${originalMessage} | Path: ${info?.path?.key}`, stack, 'ExceptionFilter');
      throw new GraphQLError(typeof message === 'string' ? message : JSON.stringify(message), {
        extensions: { code: status >= 500 ? 'INTERNAL_SERVER_ERROR' : 'BAD_USER_INPUT', status },
      });
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    this.logger.error(
      `Error: ${JSON.stringify(message)} | Status: ${status} | URL: ${request?.url}`,
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
