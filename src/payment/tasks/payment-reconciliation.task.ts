import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { LoggerService } from '../../commons/logger.service';
import { PaymentReconciliationService } from '../payment-reconciliation.service';

const CONTEXT = 'PaymentReconciliationTask';

@Injectable()
export class PaymentReconciliationTask {
  constructor(
    private readonly reconciliation: PaymentReconciliationService,
    private readonly logger: LoggerService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    const summary = await this.reconciliation.sweep(new Date());
    if (summary === null) {
      this.logger.log('Skipped: another instance is already sweeping payments', CONTEXT);
      return;
    }
    const { webhooks, attempts } = summary;
    this.logger.log(
      `Payment sweep done | webhooks processed: ${webhooks.processed}, skipped: ${webhooks.skipped}, failed: ${webhooks.failed} | attempts checked: ${attempts.checked}, settled: ${attempts.settled}, still open: ${attempts.stillOpen}, failed: ${attempts.failed}`,
      CONTEXT,
    );
  }

  @Cron('0 30 1 * * *', { timeZone: 'UTC' })
  async diffPreviousDay(): Promise<void> {
    const summary = await this.reconciliation.diffPreviousDay(new Date());
    if (summary === null) this.logger.log('Skipped: another instance is already diffing payments', CONTEXT);
  }
}
