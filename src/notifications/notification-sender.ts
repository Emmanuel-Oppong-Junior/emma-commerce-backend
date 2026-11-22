import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { EmailService } from './email/email.service';
import { EmailJobData } from './email-jobs';
import { DomainEventJobData } from '../outbox/domain-events';
import { OrderStatus, ShipmentStatus } from '../generated/prisma/client';

const CONTEXT = 'NotificationSender';
/** The order and shipment statuses a customer is emailed about: dispatch and completion, as before P1-O.2. */
const EMAILED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.COMPLETED];
const EMAILED_SHIPMENT_STATUSES: ShipmentStatus[] = [ShipmentStatus.READY_FOR_PICKUP, ShipmentStatus.OUT_FOR_DELIVERY];

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
            order.grandTotal.toFixed(2),
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
      case 'order.status_changed.v2': {
        const { payload } = data as DomainEventJobData<'order.status_changed.v2'>;
        if (!EMAILED_ORDER_STATUSES.includes(payload.to)) return;
        const order = await this.findOrder(payload.orderId, jobName);
        if (order) {
          await this.email.sendOrderStatusEmail(order.user.email, order.id, payload.to, undefined, idempotencyKey);
        }
        return;
      }
      case 'shipment.status_changed.v1': {
        const { payload } = data as DomainEventJobData<'shipment.status_changed.v1'>;
        if (!EMAILED_SHIPMENT_STATUSES.includes(payload.status)) return;
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
      case 'shipment.tracking_updated.v1': {
        const { payload } = data as DomainEventJobData<'shipment.tracking_updated.v1'>;
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
      case 'payment.dispute_opened.v1': {
        // No staff notification yet: a structured warning with ids only, for log-based alerting.
        const { payload } = data as DomainEventJobData<'payment.dispute_opened.v1'>;
        this.logger.warn(
          `Dispute opened | disputeId: ${payload.disputeId} | paymentId: ${payload.paymentId} | orderId: ${payload.orderId} | source: ${payload.source}`,
          CONTEXT,
        );
        return;
      }
      case 'inventory.low_stock.v1': {
        // No staff email template exists yet: the alert is a structured warning for log-based alerting.
        const { payload } = data as DomainEventJobData<'inventory.low_stock.v1'>;
        this.logger.warn(
          `Low stock | variantId: ${payload.variantId} | locationId: ${payload.locationId} | available: ${payload.available}`,
          CONTEXT,
        );
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
      select: { id: true, grandTotal: true, user: { select: { email: true } } },
    });
    if (!order) this.logger.warn(`No email sent: order not found | job: ${jobName} | orderId: ${orderId}`, CONTEXT);
    return order;
  }
}
