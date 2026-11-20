import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { EmailService } from './email/email.service';
import { EmailJobData } from './email-jobs';
import { DomainEventJobData } from '../outbox/domain-events';

const CONTEXT = 'NotificationSender';

/**
 * Turns one notifications-queue job into the email it stands for. Outbox events carry ids only, so the recipient is
 * read when sending; direct email jobs carry their recipient. Throws on a failed send so the queue retries.
 */
@Injectable()
export class NotificationSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly logger: LoggerService,
  ) {}

  async send(jobName: string, data: unknown, idempotencyKey: string): Promise<void> {
    switch (jobName) {
      case 'order.placed.v1': {
        const { payload } = data as DomainEventJobData<'order.placed.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (order) {
          await this.email.sendOrderConfirmationEmail(
            order.user.email,
            order.id,
            order.totalAmount.toFixed(2),
            idempotencyKey,
          );
        }
        return;
      }
      case 'order.status_changed.v1': {
        const { payload } = data as DomainEventJobData<'order.status_changed.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (order) {
          await this.email.sendOrderStatusEmail(
            order.user.email,
            order.id,
            payload.status,
            payload.trackingNumber ?? undefined,
            idempotencyKey,
          );
        }
        return;
      }
      case 'order.shipment_updated.v1': {
        const { payload } = data as DomainEventJobData<'order.shipment_updated.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (order) {
          await this.email.sendOrderStatusEmail(
            order.user.email,
            order.id,
            'SHIPPED',
            payload.trackingNumber,
            idempotencyKey,
          );
        }
        return;
      }
      case 'payment.succeeded.v1': {
        const { payload } = data as DomainEventJobData<'payment.succeeded.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (order) {
          await this.email.sendPaymentConfirmationEmail(order.user.email, order.id, payload.amount, idempotencyKey);
        }
        return;
      }
      case 'email.welcome.v1': {
        const { to, name } = data as EmailJobData['email.welcome.v1'];
        return this.email.sendWelcomeEmail(to, name, idempotencyKey);
      }
      case 'email.verification.v1': {
        const { to, verificationToken, expiresInHours } = data as EmailJobData['email.verification.v1'];
        return this.email.sendEmailVerificationEmail(to, verificationToken, expiresInHours, idempotencyKey);
      }
      case 'email.change_requested.v1': {
        const { to, newEmail } = data as EmailJobData['email.change_requested.v1'];
        return this.email.sendEmailChangeRequestedEmail(to, newEmail, idempotencyKey);
      }
      case 'email.password_reset.v1': {
        const { to, resetToken } = data as EmailJobData['email.password_reset.v1'];
        return this.email.sendPasswordResetEmail(to, resetToken, idempotencyKey);
      }
      default:
        throw new Error(`Unknown notification job "${jobName}"`);
    }
  }

  // An order hard-deleted since the event (only test cleanups do that) has nobody to notify; retrying cannot help.
  private async findOrder(orderId: string, jobName: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, totalAmount: true, user: { select: { email: true } } },
    });
    if (!order) this.logger.warn(`No email sent: order not found | job: ${jobName} | orderId: ${orderId}`, CONTEXT);
    return order;
  }
}
