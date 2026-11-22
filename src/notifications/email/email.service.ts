import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { LoggerService } from '../../commons/logger.service';
import {
  welcomeEmailHtml,
  orderConfirmationEmailHtml,
  orderStatusEmailHtml,
  paymentConfirmationEmailHtml,
  passwordResetEmailHtml,
  emailVerificationEmailHtml,
  emailChangeRequestedEmailHtml,
  RefundEmail,
  refundEmailHtml,
  LowStockDigestSection,
  lowStockDigestEmailHtml,
} from './templates/email.templates';

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}

@Injectable()
export class EmailService {
  private readonly resend: Resend | null;
  private readonly fromEmail: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly logger: LoggerService,
  ) {
    const apiKey = this.configService.get<string>('RESEND_API_KEY');
    this.fromEmail = this.configService.get<string>('RESEND_FROM_EMAIL') ?? 'noreply@franko.shop';
    this.resend = apiKey ? new Resend(apiKey) : null;
  }

  async sendWelcomeEmail(to: string, name: string, idempotencyKey?: string): Promise<void> {
    await this.send(to, 'Welcome to Emma Commerce!', welcomeEmailHtml(name), idempotencyKey);
  }

  async sendOrderConfirmationEmail(
    to: string,
    orderId: string,
    totalAmount: string,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.send(
      to,
      `Order Confirmed – #${orderId}`,
      orderConfirmationEmailHtml(orderId, totalAmount),
      idempotencyKey,
    );
  }

  async sendOrderStatusEmail(
    to: string,
    orderId: string,
    status: string,
    trackingNumber?: string,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.send(
      to,
      `Your order #${orderId} is ${status}`,
      orderStatusEmailHtml(orderId, status, trackingNumber),
      idempotencyKey,
    );
  }

  async sendPaymentConfirmationEmail(
    to: string,
    orderId: string,
    amount: string,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.send(
      to,
      `Payment received for order #${orderId}`,
      paymentConfirmationEmailHtml(orderId, amount),
      idempotencyKey,
    );
  }

  async sendRefundEmail(to: string, orderId: string, refund: RefundEmail, idempotencyKey?: string): Promise<void> {
    await this.send(to, `Refund for order #${orderId}`, refundEmailHtml(orderId, refund), idempotencyKey);
  }

  async sendLowStockDigestEmail(to: string, sections: LowStockDigestSection[], idempotencyKey?: string): Promise<void> {
    const count = sections.reduce((total, section) => total + section.items.length, 0);
    await this.send(
      to,
      `Low stock: ${count} variant${count === 1 ? '' : 's'}`,
      lowStockDigestEmailHtml(sections),
      idempotencyKey,
    );
  }

  async sendPasswordResetEmail(to: string, resetToken: string, idempotencyKey?: string): Promise<void> {
    await this.send(to, 'Reset your Emma Commerce password', passwordResetEmailHtml(resetToken), idempotencyKey);
  }

  async sendEmailVerificationEmail(
    to: string,
    verificationToken: string,
    expiresInHours: number,
    idempotencyKey?: string,
  ): Promise<void> {
    await this.send(
      to,
      'Confirm your Emma Commerce email address',
      emailVerificationEmailHtml(verificationToken, expiresInHours),
      idempotencyKey,
    );
  }

  async sendEmailChangeRequestedEmail(to: string, newEmail: string, idempotencyKey?: string): Promise<void> {
    await this.send(
      to,
      'Your Emma Commerce email address is changing',
      emailChangeRequestedEmailHtml(maskEmail(newEmail)),
      idempotencyKey,
    );
  }

  /**
   * Sends one email, or throws so the queue retries it. The error never contains the recipient or the body
   * (tokens): it ends up in logs and in the failed-job list. `idempotencyKey` (the job id) makes Resend drop a
   * resend of an email it already accepted, e.g. when a worker crashed after sending.
   */
  private async send(to: string, subject: string, html: string, idempotencyKey?: string): Promise<void> {
    const recipient = maskEmail(to);
    if (!this.resend) {
      this.logger.warn(`Email not sent (RESEND_API_KEY not configured): ${subject} → ${recipient}`, 'EmailService');
      return;
    }
    let result: Awaited<ReturnType<Resend['emails']['send']>>;
    try {
      result = await this.resend.emails.send({ from: this.fromEmail, to, subject, html }, { idempotencyKey });
    } catch (error) {
      throw new EmailDeliveryError(subject, error instanceof Error ? error.message : String(error), to);
    }
    // Resend reports API failures (quota, unverified sender, validation) in the result instead of throwing.
    if (result.error) {
      throw new EmailDeliveryError(subject, `${result.error.name}: ${result.error.message}`, to);
    }
    this.logger.log(`Email sent: ${subject} → ${recipient}`, 'EmailService');
  }
}

/** Names the email by subject only; the provider's reason has the recipient address cut out. */
export class EmailDeliveryError extends Error {
  constructor(subject: string, reason: string, recipient: string) {
    super(`Email not delivered: ${subject} | ${reason.split(recipient).join('[recipient]')}`);
    this.name = 'EmailDeliveryError';
  }
}
