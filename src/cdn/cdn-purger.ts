import { Injectable } from '@nestjs/common';
import { LoggerService } from '../commons/logger.service';
import { AppMetrics } from '../observability/metrics';
import { PurgeRequest } from './purge-plan';

export const CDN_PURGER = Symbol('CDN_PURGER');

/** Purges cached responses by surrogate key. Throwing leaves the keys pending, so the flush is retried. */
export interface CdnPurger {
  purge(request: PurgeRequest): Promise<void>;
}

/**
 * The only adapter until hosting picks a CDN: logs the purge it would send and counts it, so the invalidation path
 * runs and can be watched end to end without a CDN.
 */
@Injectable()
export class LoggingCdnPurger implements CdnPurger {
  constructor(
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
  ) {}

  async purge({ keys, reasons }: PurgeRequest): Promise<void> {
    this.logger.log(`CDN purge (no CDN configured, logged only) | keys: ${keys.length}`, 'CdnPurger', {
      surrogateKeys: keys.join(' '),
      reasons: reasons.join(','),
    });
    for (const reason of reasons) this.metrics.recordCdnPurgeRequest(reason);
  }
}
