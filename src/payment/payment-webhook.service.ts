import { BadRequestException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentProvider, WebhookEvent } from '@prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { PaymentService } from './payment.service';
import { isSettlingEvent, isValidPaystackSignature, parsePaystackWebhook } from './paystack-webhook';
import { WebhookEventRepository } from './webhook-event.repository';

/** Delays before each in-process retry; Paystack redelivers after a non-2xx answer once these are spent. */
export const WEBHOOK_RETRY_DELAYS_MS = [200, 400];

const CONTEXT = 'PaymentWebhook';

export type ReprocessOutcome = 'processed' | 'skipped' | 'failed';

@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly webhookEvents: WebhookEventRepository,
    private readonly paymentService: PaymentService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Verifies, stores and processes one Paystack delivery. Resolves (HTTP 200) once the event is stored and either
   * processed or known to need no processing. Throws 401 for a bad signature (nothing stored) and 503 when
   * processing still fails after the in-process retries: the event stays stored and unprocessed, and Paystack's
   * redelivery of it is processed again instead of being dropped as a duplicate.
   */
  async handlePaystackWebhook(rawBody: Buffer | undefined, signature: string | undefined): Promise<void> {
    if (!rawBody?.length) throw new BadRequestException('Webhook body is empty');
    const secret = this.configService.getOrThrow<string>('PAYSTACK_SECRET_KEY');
    if (!isValidPaystackSignature(rawBody, signature, secret)) {
      this.logger.warn('Webhook rejected | reason: invalid signature', CONTEXT);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const parsed = parsePaystackWebhook(rawBody);
    const { created, event } = await this.webhookEvents.record({ provider: PaymentProvider.PAYSTACK, ...parsed });
    const summary = describeEvent(event);
    if (event.processedAt) {
      this.logger.log(`Webhook duplicate ignored | ${summary}`, CONTEXT);
      return;
    }
    this.logger.log(`Webhook ${created ? 'received' : 'redelivered before processing'} | ${summary}`, CONTEXT);

    if (!isSettlingEvent(event.event) || !event.reference) {
      this.logger.log(`Webhook stored without processing | ${summary} | reason: not a settling event`, CONTEXT);
      await this.webhookEvents.markProcessed(event.id, 0);
      return;
    }
    await this.processWithRetries(event, event.reference, summary);
  }

  /**
   * One more processing attempt for an event that is stored but unprocessed, counted in its `attempts`. There are
   * no in-process retries: the caller's next sweep is the retry. Settlement is idempotent, so an event that was
   * processed meanwhile changes nothing.
   */
  async reprocessStoredEvent(event: WebhookEvent): Promise<ReprocessOutcome> {
    const summary = describeEvent(event);
    if (!isSettlingEvent(event.event) || !event.reference) {
      await this.webhookEvents.markProcessed(event.id, 0);
      return 'skipped';
    }
    try {
      await this.paymentService.verifyPayment(event.reference);
    } catch (error) {
      const lastError = describeErrorForLog(error);
      await this.webhookEvents.recordFailure(event.id, 1, lastError);
      this.logger.warn(
        `Webhook reprocessing failed | ${summary} | attempts: ${event.attempts + 1} | ${lastError}`,
        CONTEXT,
      );
      return 'failed';
    }
    await this.webhookEvents.markProcessed(event.id, 1);
    this.logger.log(`Webhook reprocessed | ${summary}`, CONTEXT);
    return 'processed';
  }

  private async processWithRetries(event: WebhookEvent, reference: string, summary: string): Promise<void> {
    let lastError = '';
    const maxAttempts = WEBHOOK_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.paymentService.verifyPayment(reference);
        await this.webhookEvents.markProcessed(event.id, attempt);
        this.logger.log(`Webhook processed | ${summary} | attempts: ${attempt}`, CONTEXT);
        return;
      } catch (error) {
        lastError = describeErrorForLog(error);
        this.logger.warn(`Webhook processing failed | ${summary} | attempt: ${attempt} | ${lastError}`, CONTEXT);
        if (attempt < maxAttempts) await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt - 1]);
      }
    }

    await this.webhookEvents.recordFailure(event.id, maxAttempts, lastError);
    this.logger.error(`Webhook left unprocessed for redelivery | ${summary}`, lastError, CONTEXT);
    throw new ServiceUnavailableException('Webhook could not be processed; it will be retried');
  }
}

function describeEvent(event: WebhookEvent): string {
  return `event: ${event.event} | reference: ${event.reference ?? 'none'} | id: ${event.id}`;
}
