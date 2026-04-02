import { Injectable, NestMiddleware } from '@nestjs/common';
import { LoggerService } from '../logger.service';
import { REQUEST_USER_KEY } from '../../iam/iam.constants';

const SLOW_REQUEST_THRESHOLD_MS = 2000;

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logger: LoggerService) {}

  use(req: any, res: any, next: () => void) {
    const start = Date.now();
    const correlationId = req.headers['x-correlation-id'] ?? this.generateId();
    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    res.on('finish', () => {
      const duration = Date.now() - start;
      const { method, originalUrl } = req;
      const status = res.statusCode;
      const userId = req[REQUEST_USER_KEY]?.id ?? 'anonymous';
      const contentLength = res.getHeader('content-length') ?? '-';

      const msg = `${method} ${originalUrl} ${status} ${duration}ms | user:${userId} | size:${contentLength} | cid:${correlationId}`;

      if (duration > SLOW_REQUEST_THRESHOLD_MS) {
        this.logger.warn(`SLOW REQUEST ${msg}`, 'HTTP');
      } else {
        this.logger.log(msg, 'HTTP');
      }
    });
    next();
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
