import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PaymentProvider, WebhookEvent } from '../generated/prisma/client';
import { LoggerService } from '../commons/logger.service';
import { describeErrorForLog } from '../commons/filters/error-classification';
import { JobQueue } from '../jobs/job-queues';
import { withJobMeta, WithJobMeta } from '../jobs/job-context';
import { PaymentService } from './payment.service';
import { isSettlingEvent, isValidPaystackSignature, parsePaystackWebhook } from './paystack-webhook';
import { WebhookEventRepository } from './webhook-event.repository';

export const PAYSTACK_WEBHOOK_JOB = 'paystack.webhook.v1';

export interface PaystackWebhookJobData {
  webhookEventId: string;
}

const CONTEXT = 'PaymentWebhook';

export type ReprocessOutcome = 'processed' | 'skipped' | 'failed';

@Injectable()
export class PaymentWebhookService {
  constructor(
    private readonly webhookEvents: WebhookEventRepository,
    private readonly paymentService: PaymentService,
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
    @InjectQueue(JobQueue.WEBHOOKS) private readonly webhookQueue: Queue,
  ) {}

  /**
   * Verifies and stores one Paystack delivery, then queues its processing (job id = stored event id) and resolves
   * (HTTP 200) as soon as it is stored. Throws 401 for a bad signature (nothing stored). Processing runs in the
   * worker with retries and backoff; if queueing fails, the stored event is still picked up by the payment sweep.
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
    await this.queueProcessing(event, summary);
  }

  /**
   * The worker's webhook job: one processing attempt for a stored event. Throws when settlement fails, so the queue
   * retries with backoff. Settlement is idempotent, so an event processed meanwhile (sweep, redelivery) is skipped.
   */
  async processStoredEvent(webhookEventId: string): Promise<void> {
    const event = await this.webhookEvents.findById(webhookEventId);
    if (!event) {
      this.logger.warn(`Webhook job skipped: stored event not found | id: ${webhookEventId}`, CONTEXT);
      return;
    }
    if (event.processedAt) return;
    const { outcome, error } = await this.processOnce(event);
    if (outcome === 'failed') throw new Error(`Webhook processing failed | ${describeEvent(event)} | ${error}`);
  }

  /**
   * One more processing attempt for an event that is stored but unprocessed, counted in its `attempts`, for the
   * payment sweep. Settlement is idempotent, so an event that was processed meanwhile changes nothing.
   */
  async reprocessStoredEvent(event: WebhookEvent): Promise<ReprocessOutcome> {
    return (await this.processOnce(event)).outcome;
  }

  private async processOnce(event: WebhookEvent): Promise<{ outcome: ReprocessOutcome; error?: string }> {
    const summary = describeEvent(event);
    if (!isSettlingEvent(event.event) || !event.reference) {
      await this.webhookEvents.markProcessed(event.id, 0);
      return { outcome: 'skipped' };
    }
    try {
      await this.paymentService.verifyPayment(event.reference);
    } catch (error) {
      const lastError = describeErrorForLog(error);
      await this.webhookEvents.recordFailure(event.id, 1, lastError);
      this.logger.warn(
        `Webhook processing failed | ${summary} | attempts: ${event.attempts + 1} | ${lastError}`,
        CONTEXT,
      );
      return { outcome: 'failed', error: lastError };
    }
    await this.webhookEvents.markProcessed(event.id, 1);
    this.logger.log(`Webhook processed | ${summary}`, CONTEXT);
    return { outcome: 'processed' };
  }

  private async queueProcessing(event: WebhookEvent, summary: string): Promise<void> {
    const data: WithJobMeta<PaystackWebhookJobData> = withJobMeta({ webhookEventId: event.id });
    try {
      await this.webhookQueue.add(PAYSTACK_WEBHOOK_JOB, data, { jobId: event.id });
      this.logger.log(`Webhook queued for processing | ${summary}`, CONTEXT);
    } catch (error) {
      this.logger.error(
        `Webhook stored but not queued; the payment sweep will process it | ${summary}`,
        describeErrorForLog(error),
        CONTEXT,
      );
    }
  }
}

function describeEvent(event: WebhookEvent): string {
  return `event: ${event.event} | reference: ${event.reference ?? 'none'} | id: ${event.id}`;
}
