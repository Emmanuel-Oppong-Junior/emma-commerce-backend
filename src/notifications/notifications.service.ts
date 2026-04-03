import { Injectable } from '@nestjs/common';
import { EmailService } from './email/email.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly emailService: EmailService) {}

  /**
   * Fires a welcome email to a newly registered user. Runs asynchronously — errors are not propagated to the caller.
   * @param to - Recipient email address.
   * @param name - The user's display name.
   */
  sendWelcomeEmail(to: string, name: string): void {
    void this.emailService.sendWelcomeEmail(to, name);
  }

  /**
   * Fires an order confirmation email after a successful order placement. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the placed order.
   * @param totalAmount - The total amount charged for the order.
   */
  sendOrderConfirmation(to: string, orderId: string, totalAmount: number): void {
    void this.emailService.sendOrderConfirmationEmail(to, orderId, totalAmount);
  }

  /**
   * Fires an order status update email when an order transitions to a new status. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the order.
   * @param status - The new order status.
   * @param trackingNumber - Optional shipment tracking number to include in the email.
   */
  sendOrderStatusUpdate(to: string, orderId: string, status: string, trackingNumber?: string): void {
    void this.emailService.sendOrderStatusEmail(to, orderId, status, trackingNumber);
  }

  /**
   * Fires a payment confirmation email after a successful payment. Runs asynchronously.
   * @param to - Recipient email address.
   * @param orderId - The ID of the order that was paid.
   * @param amount - The amount that was charged.
   */
  sendPaymentConfirmation(to: string, orderId: string, amount: number): void {
    void this.emailService.sendPaymentConfirmationEmail(to, orderId, amount);
  }

  /**
   * Fires a password reset email containing the reset token. Runs asynchronously.
   * @param to - Recipient email address.
   * @param resetToken - The one-time password reset token to include in the email.
   */
  sendPasswordReset(to: string, resetToken: string): void {
    void this.emailService.sendPasswordResetEmail(to, resetToken);
  }
}
