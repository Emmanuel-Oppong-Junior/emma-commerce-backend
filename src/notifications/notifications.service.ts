import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { JobsOptions, Queue } from 'bullmq';
import { LoggerService } from '../commons/logger.service';
import { JobQueue } from '../jobs/job-queues';
import { withJobMeta } from '../jobs/job-context';
import { EmailJobData, EmailJobName, TOKEN_EMAIL_JOB_OPTIONS } from './email-jobs';
import { PHONE_OTP_JOB_OPTIONS, READY_FOR_PICKUP_SMS_JOB_OPTIONS, SmsJobData } from './sms/sms-jobs';

/**
 * Queues the emails that are not tied to a business transaction, and the phone verification SMS; the worker sends them
 * with retries. Each email method returns at once and never fails the caller: a queueing failure is logged (without
 * the address or token).
 */
@Injectable()
export class NotificationsService {
  constructor(
    @InjectQueue(JobQueue.NOTIFICATIONS) private readonly queue: Queue,
    private readonly logger: LoggerService,
  ) {}

  sendWelcomeEmail(to: string, name: string): void {
    this.enqueue('email.welcome.v1', { to, name });
  }

  sendPasswordReset(to: string, resetToken: string): void {
    this.enqueue('email.password_reset.v1', { to, resetToken }, TOKEN_EMAIL_JOB_OPTIONS);
  }

  sendEmailVerification(to: string, verificationToken: string, expiresInHours: number): void {
    this.enqueue('email.verification.v1', { to, verificationToken, expiresInHours }, TOKEN_EMAIL_JOB_OPTIONS);
  }

  /** Tells the account's current address that a change to `newEmail` was requested (shown masked). */
  sendEmailChangeRequested(to: string, newEmail: string): void {
    this.enqueue('email.change_requested.v1', { to, newEmail });
  }

  /** Queues the phone verification SMS. Unlike the emails it fails the caller when it cannot be queued. */
  async queuePhoneOtpSms(to: string, code: string, expiresInMinutes: number): Promise<void> {
    await this.queue.add('sms.phone_otp.v1', withJobMeta({ to, code, expiresInMinutes }), PHONE_OTP_JOB_OPTIONS);
  }

  /** Queues the ready-for-pickup SMS under `jobId`, so the same notice is queued (and sent) once. */
  async queueReadyForPickupSms(jobId: string, data: SmsJobData['sms.ready_for_pickup.v1']): Promise<void> {
    await this.queue.add('sms.ready_for_pickup.v1', withJobMeta(data), { ...READY_FOR_PICKUP_SMS_JOB_OPTIONS, jobId });
  }

  private enqueue<N extends EmailJobName>(name: N, data: EmailJobData[N], opts?: JobsOptions): void {
    this.queue.add(name, withJobMeta(data), opts).catch((error: unknown) => {
      this.logger.error(
        `Email could not be queued: ${name}`,
        error instanceof Error ? error.message : String(error),
        'NotificationsService',
      );
    });
  }
}
