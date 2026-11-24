import { Injectable } from '@nestjs/common';
import {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationStatus,
} from '../generated/prisma/client';
import { LoggerService } from '../commons/logger.service';
import { EmailService } from './email/email.service';
import { SmsSender } from './sms/sms-sender';
import { SmsReceipt } from './sms/sms-provider.port';
import { AppMetrics, SmsOutcome } from '../observability/metrics';
import { NotificationErrorCode, NotificationsRepository } from './notifications.repository';
import { mayDeliver } from './preferences/notification-preferences';
import { renderEmail, renderInApp, renderSms, TemplateData, TemplateKey } from './templates/templates';

const CONTEXT = 'NotificationDispatcher';

export interface Delivery<K extends TemplateKey = TemplateKey> {
  /** Unique per message: a job that runs again finds the row and sends nothing more once it is SENT or SKIPPED. */
  dedupeKey: string;
  userId: string;
  template: K;
  data: TemplateData[K];
  channel: NotificationChannel;
  /** The email address or E.164 phone; null when the customer has none (the row is SKIPPED with NO_ADDRESS). */
  to: string | null;
  /** Passed to the provider so it drops a repeat of a message it already accepted (the job id). */
  idempotencyKey?: string;
  /** What an in-app notification is about, for the feed to link to. */
  ref?: { type: 'Order'; id: string };
}

/**
 * Sends one message through its channel and keeps its Notification row: QUEUED → SENT (with the provider message id),
 * SKIPPED (no consent at send time, no address, no provider outside production) or FAILED (then rethrows, so the job
 * retries). Consent is read now, not when the message was queued, so a withdrawal is effective at once.
 */
@Injectable()
export class NotificationDispatcher {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly email: EmailService,
    private readonly sms: SmsSender,
    private readonly logger: LoggerService,
    private readonly metrics: AppMetrics,
  ) {}

  async deliver<K extends TemplateKey>(delivery: Delivery<K>): Promise<NotificationStatus> {
    const row = await this.notifications.findOrCreate(delivery);
    if (row.status === NotificationStatus.SENT || row.status === NotificationStatus.SKIPPED) return row.status;

    const { marketingConsent, phoneVerified } =
      row.category === NotificationCategory.TRANSACTIONAL
        ? { marketingConsent: false, phoneVerified: false }
        : await this.notifications.consentFacts(delivery.userId, delivery.channel);
    if (!mayDeliver(row.category, delivery.channel, marketingConsent, phoneVerified)) {
      return this.skip(row, 'NO_CONSENT');
    }
    if (delivery.channel === NotificationChannel.IN_APP) {
      await this.notifications.markSentInApp(row.id, renderInApp(delivery.template, delivery.data), delivery.ref);
      return NotificationStatus.SENT;
    }
    if (!delivery.to) return this.skip(row, 'NO_ADDRESS');

    let sent: SmsReceipt | null;
    try {
      sent = await this.send(delivery, delivery.to);
    } catch (error) {
      await this.notifications.markFailed(row.id, 'PROVIDER_ERROR', true);
      this.countSms(row, 'failed');
      throw error;
    }
    if (!sent) return this.skip(row, 'NOT_CONFIGURED');
    await this.notifications.markSent(row.id, sent.messageId || null, sent.status ?? null);
    this.countSms(row, 'sent');
    return NotificationStatus.SENT;
  }

  private send<K extends TemplateKey>(delivery: Delivery<K>, to: string): Promise<SmsReceipt | null> {
    switch (delivery.channel) {
      case NotificationChannel.EMAIL:
        return this.email.send(to, renderEmail(delivery.template, delivery.data), delivery.idempotencyKey);
      case NotificationChannel.SMS:
        return this.sms.send(to, renderSms(delivery.template, delivery.data), delivery.template);
      default:
        throw new Error(`Channel ${delivery.channel} is not sent through the dispatcher`);
    }
  }

  private countSms(row: Notification, outcome: SmsOutcome): void {
    if (row.channel === NotificationChannel.SMS) this.metrics.recordSms(row.templateKey, outcome);
  }

  private async skip(row: Notification, reason: NotificationErrorCode): Promise<NotificationStatus> {
    await this.notifications.markSkipped(row.id, reason);
    this.countSms(row, 'skipped');
    this.logger.log(
      `Notification skipped | id: ${row.id} | template: ${row.templateKey} | channel: ${row.channel} | reason: ${reason}`,
      CONTEXT,
    );
    return NotificationStatus.SKIPPED;
  }
}
