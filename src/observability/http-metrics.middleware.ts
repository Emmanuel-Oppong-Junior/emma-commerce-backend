import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppMetrics, GRAPHQL_PATH, secondsSince } from './metrics';

/** Times every HTTP request under its route template (never the raw path, which can carry ids). */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: AppMetrics) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = performance.now();
    res.on('finish', () => {
      this.metrics.recordHttpRequest({
        method: req.method,
        route: routeTemplate(req),
        status: res.statusCode,
        seconds: secondsSince(start),
      });
    });
    next();
  }
}

/** The matched route's template (e.g. /payment/verify/:reference), /graphql, or "unmatched" (404s, scanners). */
export function routeTemplate(req: Pick<Request, 'route' | 'baseUrl' | 'originalUrl'>): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path === 'string') return `${req.baseUrl}${route.path}`;
  return req.originalUrl.split('?')[0] === GRAPHQL_PATH ? GRAPHQL_PATH : 'unmatched';
}
