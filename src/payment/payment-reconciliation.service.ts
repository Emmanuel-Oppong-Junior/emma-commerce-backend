import { Injectable } from '@nestjs/common';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { OrdersRepository } from '../order/order.repository';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { PaymentWebhookService, ReprocessOutcome } from './payment-webhook.service';
import { isSettled } from './payment-verification';
import { diffSuccessfulTransactions, Mismatch, previousUtcDay, staleAttemptWindow } from './payment-reconciliation';
import { ListedTransaction, PaystackClient } from './paystack.client';
import { WebhookEventRepository } from './webhook-event.repository';

export const PAYMENT_SWEEP_LOCK_KEY = 70_412_002;
export const PAYMENT_DIFF_LOCK_KEY = 70_412_003;
// Each batch item may wait out one Paystack timeout (8 s); the lock outlives a full batch of them.
const SWEEP_MAX_RUN_MS = 10 * 60 * 1000;
const DIFF_MAX_RUN_MS = 30 * 60 * 1000;

export const STALE_ATTEMPT_BATCH = 30;
export const WEBHOOK_SWEEP_BATCH = 30;
/** Younger events may still be inside their own request's in-process retries. */
export const WEBHOOK_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
/** Counts the webhook request's own attempts too; past it the event is left to Paystack's redeliveries and to ops. */
export const WEBHOOK_SWEEP_MAX_ATTEMPTS = 20;
export const DIFF_PAGE_SIZE = 100;
export const DIFF_MAX_PAGES = 20;

const CONTEXT = 'PaymentReconciliation';

export interface SweepSummary {
  webhooks: Record<ReprocessOutcome, number>;
  attempts: { checked: number; settled: number; stillOpen: number; failed: number };
}

export interface DiffSummary {
  day: string;
  paystackSuccesses: number;
  complete: boolean;
  mismatches: Record<Mismatch['kind'], number>;
  recovered: number;
}

/**
 * Recovers payments whose webhook was missed or failed: a frequent sweep re-processes stored webhook events and
 * re-verifies open attempts, and a nightly diff compares the previous day's Paystack successes with the ledger.
 * Every settlement goes through `PaymentService.verifyPayment`, the same idempotent path the webhook uses.
 */
@Injectable()
export class PaymentReconciliationService {
  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly webhookEvents: WebhookEventRepository,
    private readonly paymentService: PaymentService,
    private readonly webhookService: PaymentWebhookService,
    private readonly paystack: PaystackClient,
    private readonly ordersRepository: OrdersRepository,
    private readonly logger: LoggerService,
  ) {}

  /** Returns null when another instance holds the sweep lock. */
  async sweep(now: Date): Promise<SweepSummary | null> {
    return this.ordersRepository.runWithAdvisoryLock(PAYMENT_SWEEP_LOCK_KEY, SWEEP_MAX_RUN_MS, async () => ({
      webhooks: await this.reprocessUnprocessedWebhooks(now),
      attempts: await this.reverifyStaleAttempts(now),
    }));
  }

  /** Returns null when another instance holds the diff lock. */
  async diffPreviousDay(now: Date): Promise<DiffSummary | null> {
    return this.ordersRepository.runWithAdvisoryLock(PAYMENT_DIFF_LOCK_KEY, DIFF_MAX_RUN_MS, () => this.diff(now));
  }

  private async reprocessUnprocessedWebhooks(now: Date): Promise<SweepSummary['webhooks']> {
    const receivedBefore = new Date(now.getTime() - WEBHOOK_SWEEP_MIN_AGE_MS);
    const events = await this.webhookEvents.findUnprocessed(
      receivedBefore,
      WEBHOOK_SWEEP_MAX_ATTEMPTS,
      WEBHOOK_SWEEP_BATCH,
    );
    const counts: SweepSummary['webhooks'] = { processed: 0, skipped: 0, failed: 0 };
    for (const event of events) {
      let outcome: ReprocessOutcome;
      try {
        outcome = await this.webhookService.reprocessStoredEvent(event);
      } catch (error) {
        this.logger.error(`Webhook reprocessing errored | id: ${event.id}`, describeErrorForLog(error), CONTEXT);
        outcome = 'failed';
      }
      counts[outcome] += 1;
      if (outcome === 'failed' && event.attempts + 1 >= WEBHOOK_SWEEP_MAX_ATTEMPTS) {
        this.logger.error(
          `Webhook reprocessing given up | id: ${event.id} | event: ${event.event} | reference: ${event.reference ?? 'none'} | attempts: ${event.attempts + 1}`,
          undefined,
          CONTEXT,
        );
      }
    }
    return counts;
  }

  private async reverifyStaleAttempts(now: Date): Promise<SweepSummary['attempts']> {
    const { createdFrom, createdBefore } = staleAttemptWindow(now);
    const references = await this.paymentRepository.findOpenPaystackReferences(
      createdFrom,
      createdBefore,
      STALE_ATTEMPT_BATCH,
    );
    const counts = { checked: references.length, settled: 0, stillOpen: 0, failed: 0 };
    for (const reference of references) {
      try {
        const attempt = await this.paymentService.verifyPayment(reference);
        if (isSettled(attempt.status)) {
          counts.settled += 1;
          this.logger.warn(
            `Stale payment attempt settled by reconciliation | reference: ${reference} | status: ${attempt.status}`,
            CONTEXT,
          );
        } else {
          counts.stillOpen += 1;
        }
      } catch (error) {
        counts.failed += 1;
        this.logger.warn(
          `Stale payment attempt could not be re-verified | reference: ${reference} | ${describeErrorForLog(error)}`,
          CONTEXT,
        );
      }
    }
    return counts;
  }

  private async diff(now: Date): Promise<DiffSummary> {
    const { from, to } = previousUtcDay(now);
    const { transactions, complete } = await this.listSuccessfulTransactions(from, to);
    const references = [...new Set(transactions.map((transaction) => transaction.reference))];
    const attempts = references.length ? await this.paymentRepository.findLedgerAttempts(references) : [];
    const mismatches = diffSuccessfulTransactions(transactions, attempts);

    const summary: DiffSummary = {
      day: from.toISOString().slice(0, 10),
      paystackSuccesses: references.length,
      complete,
      mismatches: { PAYSTACK_ONLY: 0, UNSETTLED: 0, STATUS_MISMATCH: 0, AMOUNT_MISMATCH: 0 },
      recovered: 0,
    };
    for (const mismatch of mismatches) {
      summary.mismatches[mismatch.kind] += 1;
      this.logger.error(`Payment reconciliation mismatch | ${describeMismatch(mismatch)}`, undefined, CONTEXT);
      if (mismatch.kind === 'UNSETTLED' && (await this.settleMissed(mismatch.transaction.reference))) {
        summary.recovered += 1;
      }
    }

    const counts = Object.entries(summary.mismatches)
      .map(([kind, count]) => `${kind}: ${count}`)
      .join(' | ');
    const line = `Payment reconciliation diff | day: ${summary.day} | paystack successes: ${summary.paystackSuccesses} | ${counts} | recovered: ${summary.recovered} | complete: ${complete}`;
    if (mismatches.length > 0 || !complete) this.logger.error(line, undefined, CONTEXT);
    else this.logger.log(line, CONTEXT);
    return summary;
  }

  private async listSuccessfulTransactions(
    from: Date,
    to: Date,
  ): Promise<{ transactions: ListedTransaction[]; complete: boolean }> {
    const transactions: ListedTransaction[] = [];
    for (let page = 1; page <= DIFF_MAX_PAGES; page++) {
      const result = await this.paystack.listTransactions({
        from,
        to,
        status: 'success',
        page,
        perPage: DIFF_PAGE_SIZE,
      });
      transactions.push(...result.transactions);
      if (page >= result.pageCount || result.transactions.length === 0) return { transactions, complete: true };
    }
    this.logger.error(
      `Payment reconciliation diff truncated | pages read: ${DIFF_MAX_PAGES} | page size: ${DIFF_PAGE_SIZE}`,
      undefined,
      CONTEXT,
    );
    return { transactions, complete: false };
  }

  private async settleMissed(reference: string): Promise<boolean> {
    try {
      const attempt = await this.paymentService.verifyPayment(reference);
      this.logger.warn(
        `Missed payment settled by reconciliation | reference: ${reference} | status: ${attempt.status}`,
        CONTEXT,
      );
      return isSettled(attempt.status);
    } catch (error) {
      this.logger.error(
        `Missed payment could not be settled | reference: ${reference}`,
        describeErrorForLog(error),
        CONTEXT,
      );
      return false;
    }
  }
}

function describeMismatch({ kind, transaction, attempt }: Mismatch): string {
  const paystack = `paystack: ${transaction.amount} ${transaction.currency}`;
  const ledger = attempt
    ? `ledger: ${attempt.status} ${attempt.amount.mul(100).toFixed(0)} ${attempt.currency}`
    : 'ledger: none';
  return `kind: ${kind} | reference: ${transaction.reference} | ${paystack} | ${ledger}`;
}
