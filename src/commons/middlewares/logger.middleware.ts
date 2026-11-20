import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { LoggerService } from '../logger.service';
import { REQUEST_USER_KEY } from '../../iam/iam.constants';
import { resolveRequestId, runWithCorrelation } from '../correlation';

const SLOW_REQUEST_THRESHOLD_MS = 2000;

export const REQUEST_ID_HEADER = 'X-Request-ID';

/**
 * Gives every request an id (the client's X-Request-ID when well formed), echoes it in the response and runs the rest
 * of the request inside its correlation context, so every log record and queued job carries it. Logs one line per
 * request, without the query string (GET GraphQL queries carry inline values).
 */
@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {}

  use(req: Request & { [REQUEST_USER_KEY]?: { id?: string } }, res: Response, next: NextFunction) {
    const start = Date.now();
    const requestId = resolveRequestId(req.headers['x-request-id']);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const path = req.originalUrl.split('?')[0];
      const fields = {
        requestId,
        userId: req[REQUEST_USER_KEY]?.id,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs,
      };
      const message = `${req.method} ${path} ${res.statusCode} ${durationMs}ms`;
      if (durationMs > SLOW_REQUEST_THRESHOLD_MS) {
        this.logger.warn(`SLOW REQUEST ${message}`, 'HTTP', fields);
      } else {
        this.logger.log(message, 'HTTP', fields);
      }
    });
    runWithCorrelation({ requestId, request: req }, next);
  }
}
