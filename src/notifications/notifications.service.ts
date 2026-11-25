import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { withJobMeta } from '../jobs/job-context';
import { NotificationChannel } from '../generated/prisma/client';
import { EmailJobData, EmailJobName, TOKEN_EMAIL_JOB_OPTIONS } from './email-jobs';
import { PHONE_OTP_JOB_OPTIONS, READY_FOR_PICKUP_SMS_JOB_OPTIONS, SmsJobData } from './sms/sms-jobs';
import { NotificationsRepository } from './notifications.repository';
import { TemplateKey } from './templates/templates';

const CONTEXT = 'NotificationsService';

/**
 * Queues the messages that are not tied to a business transaction (sign-up, verification, password reset, the phone
 * code); the worker sends them with retries. Each first writes its Notification row (QUEUED), whose key travels in
 * the job. The email methods return at once and never fail the caller: a failure is logged (without the address or
 * token) and the row marked FAILED with QUEUE_ERROR.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectQueue(JobQueue.NOTIFICATIONS) private readonly queue: Queue,
    private readonly notifications: NotificationsRepository,
    private readonly logger: LoggerService,
  ) {}

  sendWelcomeEmail(userId: string, to: string, name: string): void {
    this.enqueueEmail('email.welcome.v1', 'account.welcome', userId, { to, name });
  }

  sendPasswordReset(userId: string, to: string, resetToken: string): void {
    this.enqueueEmail(
      'email.password_reset.v1',
      'account.password_reset',
      userId,
      { to, resetToken },
      TOKEN_EMAIL_JOB_OPTIONS,
    );
  }

  sendEmailVerification(userId: string, to: string, verificationToken: string, expiresInHours: number): void {
    this.enqueueEmail(
      'email.verification.v1',
      'account.email_verification',
      userId,
      { to, verificationToken, expiresInHours },
      TOKEN_EMAIL_JOB_OPTIONS,
    );
  }

  /** Tells the account's current address that a change to `newEmail` was requested (shown masked). */
  sendEmailChangeRequested(userId: string, to: string, newEmail: string): void {
    this.enqueueEmail('email.change_requested.v1', 'account.email_change_requested', userId, { to, newEmail });
  }

  /** Queues the phone verification SMS. Unlike the emails it fails the caller when it cannot be queued. */
  async queuePhoneOtpSms(userId: string, to: string, code: string, expiresInMinutes: number): Promise<void> {
    await this.queueDirect(
      'sms.phone_otp.v1',
      'account.phone_otp',
      NotificationChannel.SMS,
      userId,
      { to, code, expiresInMinutes },
      PHONE_OTP_JOB_OPTIONS,
    );
  }

  /**
   * Queues a shipment milestone SMS (with the queue's retry options) under `jobId`, derived from the outbox event, so
   * the event job running again queues it once; the processor's sent marker keeps it to one send.
   */
  async queueShipmentSms(data: SmsJobData['sms.shipment_milestone.v1'], jobId: string): Promise<void> {
    await this.queue.add('sms.shipment_milestone.v1', withJobMeta(data), { jobId });
  }

  /** Queues the ready-for-pickup SMS under `jobId`, so the same notice is queued (and sent) once. */
  async queueReadyForPickupSms(jobId: string, data: SmsJobData['sms.ready_for_pickup.v1']): Promise<void> {
    await this.queue.add('sms.ready_for_pickup.v1', withJobMeta(data), { ...READY_FOR_PICKUP_SMS_JOB_OPTIONS, jobId });
  }

  private enqueueEmail<N extends EmailJobName>(
    name: N,
    template: TemplateKey,
    userId: string,
    data: Omit<EmailJobData[N], 'userId' | 'dedupeKey'>,
    opts?: JobsOptions,
  ): void {
    this.queueDirect(name, template, NotificationChannel.EMAIL, userId, data, opts).catch((error: unknown) => {
      this.logger.error(
        `Email could not be queued: ${name}`,
        error instanceof Error ? error.message : String(error),
        CONTEXT,
      );
    });
  }

  private async queueDirect(
    name: string,
    template: TemplateKey,
    channel: NotificationChannel,
    userId: string,
    data: object,
    opts?: JobsOptions,
  ): Promise<void> {
    const dedupeKey = `direct:${randomUUID()}`;
    const row = await this.notifications.findOrCreate({ dedupeKey, userId, template, channel });
    try {
      await this.queue.add(name, withJobMeta({ ...data, userId, dedupeKey }), opts);
    } catch (error) {
      await this.notifications.markFailed(row.id, 'QUEUE_ERROR', false);
      throw error;
    }
  }
}
