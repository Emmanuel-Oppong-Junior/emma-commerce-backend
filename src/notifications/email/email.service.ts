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
} from './templates/email.templates';

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

  async sendWelcomeEmail(to: string, name: string): Promise<void> {
    await this.send(to, 'Welcome to Franko!', welcomeEmailHtml(name));
  }

  async sendOrderConfirmationEmail(to: string, orderId: string, totalAmount: number): Promise<void> {
    await this.send(to, `Order Confirmed – #${orderId}`, orderConfirmationEmailHtml(orderId, totalAmount));
  }

  async sendOrderStatusEmail(to: string, orderId: string, status: string, trackingNumber?: string): Promise<void> {
    await this.send(to, `Your order #${orderId} is ${status}`, orderStatusEmailHtml(orderId, status, trackingNumber));
  }

  async sendPaymentConfirmationEmail(to: string, orderId: string, amount: number): Promise<void> {
    await this.send(to, `Payment received for order #${orderId}`, paymentConfirmationEmailHtml(orderId, amount));
  }

  async sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
    await this.send(to, 'Reset your Franko password', passwordResetEmailHtml(resetToken));
  }

  private async send(to: string, subject: string, html: string): Promise<void> {
    if (!this.resend) {
      this.logger.warn(`Email not sent (RESEND_API_KEY not configured): ${subject} → ${to}`, 'EmailService');
      return;
    }
    try {
      await this.resend.emails.send({ from: this.fromEmail, to, subject, html });
      this.logger.log(`Email sent: ${subject} → ${to}`, 'EmailService');
    } catch (error) {
      this.logger.error(`Failed to send email: ${subject} → ${to}`, error instanceof Error ? error.message : String(error), 'EmailService');
    }
  }
}
