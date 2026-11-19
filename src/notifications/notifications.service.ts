import { Injectable } from '@nestjs/common';
import { EmailService } from './email/email.service';
import { LoggerService } from '../commons/logger.service';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly emailService: EmailService,
    private readonly logger: LoggerService,
  ) {}

  /**
   * Fires a welcome email to a newly registered user. Runs asynchronously — errors are not propagated to the caller.
   * @param to - Recipient email address.
   * @param name - The user's display name.
   */
  sendWelcomeEmail(to: string, name: string): void {
    this.fireAndForget('welcome', this.emailService.sendWelcomeEmail(to, name));
  }

  /**
   * Fires an order confirmation email after a successful order placement. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the placed order.
   * @param totalAmount - The total amount charged for the order.
   */
  sendOrderConfirmation(to: string, orderId: string, totalAmount: string): void {
    this.fireAndForget('order confirmation', this.emailService.sendOrderConfirmationEmail(to, orderId, totalAmount));
  }

  /**
   * Fires an order status update email when an order transitions to a new status. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the order.
   * @param status - The new order status.
   * @param trackingNumber - Optional shipment tracking number to include in the email.
   */
  sendOrderStatusUpdate(to: string, orderId: string, status: string, trackingNumber?: string): void {
    this.fireAndForget('order status', this.emailService.sendOrderStatusEmail(to, orderId, status, trackingNumber));
  }

  /**
   * Fires a payment confirmation email after a successful payment. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the order that was paid.
   * @param amount - The amount that was charged.
   */
  sendPaymentConfirmation(to: string, orderId: string, amount: string): void {
    this.fireAndForget('payment confirmation', this.emailService.sendPaymentConfirmationEmail(to, orderId, amount));
  }

  /**
   * Fires a password reset email containing the reset token. Runs asynchronously.
   * @param to - Recipient email address.
   * @param resetToken - The one-time password reset token to include in the email.
   */
  sendPasswordReset(to: string, resetToken: string): void {
    this.fireAndForget('password reset', this.emailService.sendPasswordResetEmail(to, resetToken));
  }

  /**
   * Fires an email asking the recipient to confirm the address with the given token. Runs asynchronously.
   * @param to - The address being verified (a new sign-up's email, or a pending new email).
   * @param verificationToken - The one-time verification token to include in the email.
   * @param expiresInHours - How long the token stays valid, shown to the recipient.
   */
  sendEmailVerification(to: string, verificationToken: string, expiresInHours: number): void {
    this.fireAndForget(
      'email verification',
      this.emailService.sendEmailVerificationEmail(to, verificationToken, expiresInHours),
    );
  }

  /**
   * Fires a notice to an account's current address that a change to another address was requested. Runs asynchronously.
   * @param to - The account's current email address.
   * @param newEmail - The requested new address; only a masked form is shown.
   */
  sendEmailChangeRequested(to: string, newEmail: string): void {
    this.fireAndForget('email change notice', this.emailService.sendEmailChangeRequestedEmail(to, newEmail));
  }

  private fireAndForget(emailKind: string, send: Promise<void>): void {
    send.catch((error: unknown) => {
      this.logger.error(
        `Email notification failed: ${emailKind}`,
        error instanceof Error ? error.message : String(error),
        'NotificationsService',
      );
    });
  }
}
