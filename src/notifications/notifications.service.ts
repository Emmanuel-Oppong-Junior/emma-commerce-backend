import { Injectable } from '@nestjs/common';
import { EmailService } from './email/email.service';

@Injectable()
export class NotificationsService {
  constructor(private readonly emailService: EmailService) {}

  sendWelcomeEmail(to: string, name: string): void {
    void this.emailService.sendWelcomeEmail(to, name);
  }

  sendOrderConfirmation(to: string, orderId: string, totalAmount: number): void {
    void this.emailService.sendOrderConfirmationEmail(to, orderId, totalAmount);
  }

  sendOrderStatusUpdate(to: string, orderId: string, status: string, trackingNumber?: string): void {
    void this.emailService.sendOrderStatusEmail(to, orderId, status, trackingNumber);
  }

  sendPaymentConfirmation(to: string, orderId: string, amount: number): void {
    void this.emailService.sendPaymentConfirmationEmail(to, orderId, amount);
  }

  sendPasswordReset(to: string, resetToken: string): void {
    void this.emailService.sendPasswordResetEmail(to, resetToken);
  }
}
