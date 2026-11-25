import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { LoggerService } from '../../commons/logger.service';
import { EmailContent } from '../templates/templates';

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

const CONTEXT = 'EmailService';

/** The email channel's transport (Resend). Content comes rendered from the template registry. */
@Injectable()
export class EmailService {
  private readonly resend: Resend | null;
  private readonly fromEmail: string | null;

  constructor(
    configService: ConfigService,
    private readonly logger: LoggerService,
  ) {
    // Env validation requires both in production and the sender with any key, so neither has a default.
    const apiKey = configService.get<string>('RESEND_API_KEY');
    this.fromEmail = configService.get<string>('RESEND_FROM_EMAIL') ?? null;
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  /**
   * Sends one email and returns Resend's message id, or null when no provider is configured (development and test
   * only), or throws so the queue retries it. The error never contains the recipient or the body (tokens): it ends up
   * in logs and in the failed-job list. `idempotencyKey` (the job id) makes Resend drop a resend of an email it already
   * accepted, e.g. when a worker crashed after sending.
   */
  async send(to: string, content: EmailContent, idempotencyKey?: string): Promise<{ messageId: string } | null> {
    const recipient = maskEmail(to);
    const { subject, html, text } = content;
    if (!this.resend || !this.fromEmail) {
      this.logger.warn(`Email not sent (RESEND_API_KEY not configured): ${subject} → ${recipient}`, CONTEXT);
      return null;
    }
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.resend.emails.send({ from: this.fromEmail, to, subject, html, text }, { idempotencyKey });
    } catch (error) {
      throw new EmailDeliveryError(subject, error instanceof Error ? error.message : String(error), to);
    }
    // Resend reports API failures (quota, unverified sender, validation) in the result instead of throwing.
    if (result.error) {
      throw new EmailDeliveryError(subject, `${result.error.name}: ${result.error.message}`, to);
    }
    const messageId = result.data?.id ?? '';
    this.logger.log(`Email sent: ${subject} → ${recipient} | messageId: ${messageId}`, CONTEXT);
    return { messageId };
  }
}

/** Names the email by subject only; the provider's reason has the recipient address cut out. */
export class EmailDeliveryError extends Error {
  constructor(subject: string, reason: string, recipient: string) {
    super(`Email not delivered: ${subject} | ${reason.split(recipient).join('[recipient]')}`);
    this.name = 'EmailDeliveryError';
  }
}
