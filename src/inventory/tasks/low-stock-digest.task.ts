import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { LoggerService } from '../../commons/logger.service';
import { DigestRun, LowStockAlertsService } from '../low-stock/low-stock-alerts.service';

const CONTEXT = 'LowStockDigestTask';

/** Repeatable job (every 3 hours): emails staff the variants that went low since the last digest, if any. */
@Injectable()
export class LowStockDigestTask {
  constructor(
    private readonly alerts: LowStockAlertsService,
    private readonly logger: LoggerService,
  ) {}

  async send(): Promise<DigestRun | null> {
    const run = await this.alerts.sendDigest(randomUUID(), new Date());
    if (run === null) {
      this.logger.log('Skipped: another instance is already sending the low-stock digest', CONTEXT);
      return null;
    }
    this.logger.log(
      `Low-stock digest done | digestId: ${run.digestId ?? 'none'} | listed: ${run.listed} | dropped: ${run.dropped} | recipients: ${run.recipients}`,
      CONTEXT,
    );
    if (run.listed > 0 && run.recipients === 0) {
      this.logger.warn('Low-stock digest has no recipients: no active staff member holds inventory.alerts', CONTEXT);
    }
    return run;
  }
}
