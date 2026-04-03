import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { LoggerService } from '../logger.service';
import { REQUEST_USER_KEY } from '../../iam/iam.constants';

const SLOW_REQUEST_THRESHOLD_MS = 2000;

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {}

  use(
    req: Request & { correlationId?: string; [REQUEST_USER_KEY]?: { id: string } },
    res: Response,
    next: NextFunction,
  ) {
    const start = Date.now();
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    req.correlationId = requestId;
    res.setHeader('X-Request-ID', requestId);

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { method, originalUrl } = req;
      const status = res.statusCode;
      const userId = req[REQUEST_USER_KEY]?.id ?? 'anonymous';
      const contentLength = res.getHeader('content-length') ?? '-';

      const msg = `${method} ${originalUrl} ${status} ${duration}ms | user:${userId} | size:${contentLength} | rid:${requestId}`;

      if (duration > SLOW_REQUEST_THRESHOLD_MS) {
        this.logger.warn(`SLOW REQUEST ${msg}`, 'HTTP');
      } else {
        this.logger.log(msg, 'HTTP');
      }
    });
    next();
  }
}
