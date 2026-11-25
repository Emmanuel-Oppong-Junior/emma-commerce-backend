import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { DirectNotificationRef, EmailJobData } from './email-jobs';
import { DomainEventJobData } from '../outbox/domain-events';
import { NotificationChannel, OrderStatus, PaymentMethod, ShipmentStatus } from '../generated/prisma/client';
import { REFUND_REASON_LABELS } from '../returns/refund-reason';
import { SmsJobData } from './sms/sms-jobs';
import { ReadyForPickupNotifier } from './ready-for-pickup.notifier';
import { LowStockAlertsService } from '../inventory/low-stock/low-stock-alerts.service';
import { verifiedPhoneOf } from '../phone-verification/phone-otp';
import { NotificationsService } from './notifications.service';
import { SHIPMENT_SMS_STATUSES, shipmentSmsRecipient } from './sms/shipment-sms';
import { DeliveryCodes } from '../delivery/code/delivery-codes.service';
import { deliveryCodeDispatch } from '../delivery/code/delivery-code';
import { NotificationDispatcher } from './notification-dispatcher';
import { TemplateData, TemplateKey } from './templates/templates';
import { maskEmail } from './email/email.service';
import { MarketingLinks } from './marketing-links';
import { variantLabel } from '../cart/abandoned/abandoned-cart';
import { GuestOrderAccess } from '../guest-checkout/guest-order-access';

/** The order fields a customer message needs: who it goes to (account, or guest contact) and what it says. */
interface OrderRecipient {
  id: string;
  userId: string | null;
  contactEmail: string | null;
  guestPhone: string | null;
  user: { email: string } | null;
}

const CONTEXT = 'NotificationSender';
/** The order and shipment statuses a customer is emailed about: dispatch and completion, as before P1-O.2. */
const EMAILED_ORDER_STATUSES: OrderStatus[] = [OrderStatus.COMPLETED];
// READY_FOR_PICKUP has its own email and SMS (ReadyForPickupNotifier, P5-E.1).
const EMAILED_SHIPMENT_STATUSES: ShipmentStatus[] = [ShipmentStatus.OUT_FOR_DELIVERY];
/**
 * The in-app feed (P6-N.4) gets what a customer acts on: order placed, payment received, out for delivery, delivered,
 * ready for pickup (ReadyForPickupNotifier) and refund sent. Completion and tracking-number edits stay email only.
 */
const IN_APP_SHIPMENT_STATUSES: ShipmentStatus[] = [ShipmentStatus.OUT_FOR_DELIVERY, ShipmentStatus.DELIVERED];

/** Where the password-reset link sends the customer; the token goes in the fragment, which browsers never send on. */
export function passwordResetUrl(frontendUrl: string, resetToken: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}/reset-password#token=${encodeURIComponent(resetToken)}`;
}

/**
 * Turns one notifications-queue job into the messages it stands for, each rendered from the template registry and
 * recorded as a Notification row by the dispatcher. Outbox events carry ids only, so the recipient is read when
 * sending; direct jobs carry their recipient. Throws on a failed send so the queue retries. A guest order (P6-G.1) is
 * emailed at its contact email when it has one and texted at its verified phone (placed, with its access link, and
 * paid); it has no in-app feed, and its rows name the order instead of an account.
 */
@Injectable()
export class NotificationSender {
  private readonly frontendUrl: string;
  private readonly resetTokenMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatcher: NotificationDispatcher,
    private readonly logger: LoggerService,
    private readonly lowStockAlerts: LowStockAlertsService,
    private readonly notifications: NotificationsService,
    private readonly readyForPickup: ReadyForPickupNotifier,
    private readonly deliveryCodes: DeliveryCodes,
    private readonly marketingLinks: MarketingLinks,
    private readonly guestOrderAccess: GuestOrderAccess,
    config: ConfigService,
  ) {
    this.frontendUrl = config.getOrThrow<string>('FRONTEND_URL');
    this.resetTokenMinutes = Math.round(config.getOrThrow<number>('JWT_RESET_TOKEN_TTL') / 60);
  }

  async send(jobName: string, data: unknown, jobId: string): Promise<void> {
    switch (jobName) {
      case 'order.placed.v1': {
        const { payload } = data as DomainEventJobData<'order.placed.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        const placed: TemplateData['order.placed'] = {
          orderNumber: order.orderNumber,
          currency: order.currency,
          lines: order.items.map((item) => ({
            productName: item.productName,
            quantity: item.quantity,
            lineTotal: item.lineTotal.toFixed(2),
          })),
          shippingTotal: order.shippingTotal?.toFixed(2) ?? null,
          discountTotal: order.discountTotal?.toFixed(2) ?? null,
          grandTotal: order.grandTotal.toFixed(2),
          cashOnDelivery: order.paymentMethod === PaymentMethod.CASH_ON_DELIVERY,
        };
        if (order.userId === null) {
          const guestPlaced = { ...placed, orderUrl: this.guestOrderAccess.urlFor(order.id) };
          await this.emailOrder(order, jobId, 'order.guest_placed', guestPlaced);
          await this.smsGuestOrder(order, jobId, 'order.guest_placed', guestPlaced);
          return;
        }
        await this.emailOrder(order, jobId, 'order.placed', placed);
        await this.inAppOrder(order, jobId, 'order.placed', placed);
        return;
      }
      case 'order.status_changed.v1': {
        const { payload } = data as DomainEventJobData<'order.status_changed.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        await this.emailOrder(order, jobId, 'order.updated', {
          orderNumber: order.orderNumber,
          status: payload.status,
          trackingNumber: payload.trackingNumber,
        });
        return;
      }
      case 'order.shipment_updated.v1':
      case 'shipment.tracking_updated.v1': {
        const { payload } = data as DomainEventJobData<'shipment.tracking_updated.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        await this.emailOrder(order, jobId, 'shipment.dispatched', {
          orderNumber: order.orderNumber,
          trackingNumber: payload.trackingNumber,
        });
        return;
      }
      case 'order.status_changed.v2': {
        const { payload } = data as DomainEventJobData<'order.status_changed.v2'>;
        if (!EMAILED_ORDER_STATUSES.includes(payload.to)) return;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        await this.emailOrder(order, jobId, 'order.completed', { orderNumber: order.orderNumber });
        return;
      }
      case 'shipment.status_changed.v1': {
        const { payload } = data as DomainEventJobData<'shipment.status_changed.v1'>;
        if (payload.status === ShipmentStatus.READY_FOR_PICKUP) {
          return this.readyForPickup.notify(payload.orderId, jobId);
        }
        if (SHIPMENT_SMS_STATUSES.includes(payload.status)) {
          const { orderId, shipmentId, status } = payload;
          await this.notifications.queueShipmentSms({ orderId, shipmentId, status }, `${jobId}-sms`);
        }
        const emailed = EMAILED_SHIPMENT_STATUSES.includes(payload.status);
        if (!emailed && !IN_APP_SHIPMENT_STATUSES.includes(payload.status)) return;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        if (payload.status === ShipmentStatus.DELIVERED) {
          await this.inAppOrder(order, jobId, 'shipment.delivered', { orderNumber: order.orderNumber });
          return;
        }
        const outForDelivery = {
          orderNumber: order.orderNumber,
          carrier: payload.carrier ?? null,
          trackingNumber: payload.trackingNumber,
          deliveryCode: null,
        };
        if (emailed) await this.emailOrder(order, jobId, 'shipment.out_for_delivery', outForDelivery);
        await this.inAppOrder(order, jobId, 'shipment.out_for_delivery', outForDelivery);
        return;
      }
      case 'payment.succeeded.v1': {
        const { payload } = data as DomainEventJobData<'payment.succeeded.v1'>;
        const order = await this.findOrder(payload.orderId, jobName);
        if (!order) return;
        const received = { orderNumber: order.orderNumber, amount: payload.amount, currency: order.currency };
        await this.emailOrder(order, jobId, 'payment.received', received);
        await this.inAppOrder(order, jobId, 'payment.received', received);
        await this.smsGuestOrder(order, jobId, 'payment.received', received);
        return;
      }
      case 'refund.succeeded.v1': {
        const { payload } = data as DomainEventJobData<'refund.succeeded.v1'>;
        const refund = await this.findRefund(payload.refundId, jobName);
        const order = refund && (await this.findOrder(payload.orderId, jobName));
        if (!refund || !order) return;
        const processed = {
          orderNumber: order.orderNumber,
          amount: refund.amount.toFixed(2),
          currency: refund.currency,
          reasonLabel: REFUND_REASON_LABELS[refund.reason],
          lines: refund.lines.map((line) => ({ productName: line.orderItem.productName, quantity: line.quantity })),
          includesShipping: refund.shippingAmount.gt(0),
        };
        await this.emailOrder(order, jobId, 'refund.processed', processed);
        await this.inAppOrder(order, jobId, 'refund.processed', processed);
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
      case 'cod.remittance_discrepancy.v1': {
        // No staff notification yet: a structured warning with ids only, for log-based alerting.
        const { payload } = data as DomainEventJobData<'cod.remittance_discrepancy.v1'>;
        this.logger.warn(
          `COD remittance discrepancy | remittanceId: ${payload.remittanceId} | riderId: ${payload.riderId} | kind: ${payload.kind}`,
          CONTEXT,
        );
        return;
      }
      case 'return.status_changed.v1': {
        // No customer email yet (it comes with the template registry): a structured log line with ids only.
        const { payload } = data as DomainEventJobData<'return.status_changed.v1'>;
        this.logger.log(
          `Return status changed | returnRequestId: ${payload.returnRequestId} | orderId: ${payload.orderId} | status: ${payload.status}`,
          CONTEXT,
        );
        return;
      }
      case 'inventory.low_stock.v1': {
        // Staff are emailed in the next digest (LowStockDigestTask), one pending alert per variant and location.
        const { eventId, payload } = data as DomainEventJobData<'inventory.low_stock.v1'>;
        await this.lowStockAlerts.recordPending(eventId, payload);
        return;
      }
      case 'inventory.low_stock_digest.v1': {
        const { payload } = data as DomainEventJobData<'inventory.low_stock_digest.v1'>;
        const recipient = await this.prisma.user.findUnique({
          where: { id: payload.recipientId },
          select: { id: true, email: true, isActive: true },
        });
        if (!recipient?.isActive) {
          this.logger.warn(
            `No email sent: digest recipient gone or inactive | digestId: ${payload.digestId} | userId: ${payload.recipientId}`,
            CONTEXT,
          );
          return;
        }
        const sections = await this.lowStockAlerts.digestSections(payload.digestId);
        await this.dispatcher.deliver({
          dedupeKey: `${jobId}:${NotificationChannel.EMAIL}`,
          userId: recipient.id,
          template: 'inventory.low_stock_digest',
          data: { sections },
          channel: NotificationChannel.EMAIL,
          to: recipient.email,
          idempotencyKey: jobId,
        });
        return;
      }
      case 'cart.abandoned_reminder.v1': {
        const { payload } = data as DomainEventJobData<'cart.abandoned_reminder.v1'>;
        return this.sendAbandonedCartReminder(payload.userId, jobId);
      }
      case 'email.welcome.v1': {
        const job = data as EmailJobData['email.welcome.v1'];
        return this.emailDirect(job, jobId, 'account.welcome', { name: job.name || null });
      }
      case 'email.verification.v1': {
        const job = data as EmailJobData['email.verification.v1'];
        return this.emailDirect(job, jobId, 'account.email_verification', {
          verificationToken: job.verificationToken,
          expiresInHours: job.expiresInHours,
        });
      }
      case 'email.change_requested.v1': {
        const job = data as EmailJobData['email.change_requested.v1'];
        return this.emailDirect(job, jobId, 'account.email_change_requested', {
          maskedNewEmail: maskEmail(job.newEmail),
        });
      }
      case 'email.password_reset.v1': {
        const job = data as EmailJobData['email.password_reset.v1'];
        return this.emailDirect(job, jobId, 'account.password_reset', {
          resetUrl: passwordResetUrl(this.frontendUrl, job.resetToken),
          expiresInMinutes: this.resetTokenMinutes,
        });
      }
      case 'sms.phone_otp.v1': {
        const job = data as SmsJobData['sms.phone_otp.v1'];
        if (job.guestCartId) {
          await this.dispatcher.deliver({
            dedupeKey: job.dedupeKey ?? `${jobId}:${NotificationChannel.SMS}`,
            userId: null,
            template: 'account.phone_otp',
            data: { code: job.code, expiresInMinutes: job.expiresInMinutes },
            channel: NotificationChannel.SMS,
            to: job.to,
            ref: { type: 'GuestCart', id: job.guestCartId },
          });
          return;
        }
        const userId = job.userId ?? (await this.userIdByPhone(job.to));
        if (!userId) {
          this.logger.warn(`No SMS sent: no account for the phone | job: ${jobName} | jobId: ${jobId}`, CONTEXT);
          return;
        }
        await this.dispatcher.deliver({
          dedupeKey: job.dedupeKey ?? `${jobId}:${NotificationChannel.SMS}`,
          userId,
          template: 'account.phone_otp',
          data: { code: job.code, expiresInMinutes: job.expiresInMinutes },
          channel: NotificationChannel.SMS,
          to: job.to,
        });
        return;
      }
      case 'sms.shipment_milestone.v1':
        return this.sendShipmentSms(data as SmsJobData['sms.shipment_milestone.v1'], jobId);
      case 'sms.ready_for_pickup.v1': {
        const { to, notice, userId, guestOrderId } = data as SmsJobData['sms.ready_for_pickup.v1'];
        if (guestOrderId) {
          await this.dispatcher.deliver({
            dedupeKey: `${jobId}:${NotificationChannel.SMS}`,
            userId: null,
            template: 'shipment.ready_for_pickup',
            data: notice,
            channel: NotificationChannel.SMS,
            to,
            ref: { type: 'Order', id: guestOrderId },
          });
          return;
        }
        const recipientId = userId ?? (await this.userIdByOrderNumber(notice.orderNumber));
        if (!recipientId) {
          this.logger.warn(`No SMS sent: pickup order not found | orderNumber: ${notice.orderNumber}`, CONTEXT);
          return;
        }
        await this.dispatcher.deliver({
          dedupeKey: `${jobId}:${NotificationChannel.SMS}`,
          userId: recipientId,
          template: 'shipment.ready_for_pickup',
          data: notice,
          channel: NotificationChannel.SMS,
          to,
        });
        return;
      }
      default:
        throw new Error(`Unknown notification job "${jobName}"`);
    }
  }

  private async sendShipmentSms(
    { orderId, shipmentId, status }: SmsJobData['sms.shipment_milestone.v1'],
    jobId: string,
  ) {
    const shipment = await this.prisma.shipment.findUnique({
      where: { id: shipmentId },
      select: {
        carrier: true,
        trackingNumber: true,
        status: true,
        riderId: true,
        dispatchedAt: true,
        order: {
          select: {
            orderNumber: true,
            userId: true,
            contactPhone: true,
            guestPhone: true,
            shippingAddressSnapshot: true,
            user: { select: { phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedNumber: true } },
          },
        },
      },
    });
    if (!shipment) {
      this.logger.warn(`No SMS sent: shipment not found | orderId: ${orderId} | shipmentId: ${shipmentId}`, CONTEXT);
      return;
    }
    const { order } = shipment;
    const addressPhone = (order.shippingAddressSnapshot as { phone?: unknown } | null)?.phone;
    const to = shipmentSmsRecipient({
      verifiedPhone: order.user ? verifiedPhoneOf(order.user) : order.guestPhone,
      addressPhone: typeof addressPhone === 'string' ? addressPhone : null,
      contactPhone: order.contactPhone,
    });
    if (!to) this.logger.warn(`No SMS sent: no Ghana phone for the order | orderId: ${orderId}`, CONTEXT);
    const sms = {
      dedupeKey: `${jobId}:${NotificationChannel.SMS}`,
      userId: order.userId,
      channel: NotificationChannel.SMS,
      to,
      ...(order.userId === null && { ref: { type: 'Order' as const, id: orderId } }),
    };
    if (status === ShipmentStatus.DELIVERED) {
      await this.dispatcher.deliver({
        ...sms,
        template: 'shipment.delivered',
        data: { orderNumber: order.orderNumber },
      });
      return;
    }
    // P5-C.2: a rider's shipment still out for delivery carries its delivery code in the same text.
    const codeFor = to ? deliveryCodeDispatch(shipment) : null;
    await this.dispatcher.deliver({
      ...sms,
      template: 'shipment.out_for_delivery',
      data: {
        orderNumber: order.orderNumber,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
        deliveryCode: codeFor ? await this.deliveryCodes.issue(shipmentId, codeFor) : null,
      },
    });
  }

  /**
   * The abandoned-cart reminder (marketing, P6-G.2): the cart as it is now, by email and to a verified phone by SMS.
   * The dispatcher checks consent for each channel when sending, so a withdrawal since the reminder was recorded wins.
   */
  private async sendAbandonedCartReminder(userId: string, jobId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        isActive: true,
        phoneNumber: true,
        phoneVerifiedAt: true,
        phoneVerifiedNumber: true,
        cart: {
          select: {
            items: {
              select: {
                quantity: true,
                variant: { select: { optionValues: true, product: { select: { name: true } } } },
              },
              orderBy: { createdAt: 'asc' },
            },
          },
        },
      },
    });
    const items = user?.cart?.items ?? [];
    if (!user?.isActive || items.length === 0) {
      this.logger.log(`No abandoned-cart reminder sent: account inactive or cart emptied | userId: ${userId}`, CONTEXT);
      return;
    }
    const data: TemplateData['cart.abandoned'] = {
      items: items.map((item) => ({
        productName: item.variant.product.name,
        variantLabel: variantLabel(item.variant.optionValues),
        quantity: item.quantity,
      })),
      cartUrl: this.marketingLinks.cartUrl(),
      unsubscribeUrl: this.marketingLinks.unsubscribeUrl(userId),
    };
    await this.dispatcher.deliver({
      dedupeKey: `${jobId}:${NotificationChannel.EMAIL}`,
      userId,
      template: 'cart.abandoned',
      data,
      channel: NotificationChannel.EMAIL,
      to: user.email,
      idempotencyKey: jobId,
    });
    await this.dispatcher.deliver({
      dedupeKey: `${jobId}:${NotificationChannel.SMS}`,
      userId,
      template: 'cart.abandoned',
      data,
      channel: NotificationChannel.SMS,
      to: verifiedPhoneOf(user),
    });
  }

  /**
   * Emails the order's customer (a guest at the contact email, if given); the row is keyed on the job, so the event
   * running again sends nothing more.
   */
  private async emailOrder<K extends TemplateKey>(
    order: OrderRecipient,
    jobId: string,
    template: K,
    data: TemplateData[K],
  ): Promise<void> {
    await this.dispatcher.deliver({
      dedupeKey: `${jobId}:${NotificationChannel.EMAIL}`,
      userId: order.userId,
      template,
      data,
      channel: NotificationChannel.EMAIL,
      to: order.user?.email ?? order.contactEmail,
      idempotencyKey: jobId,
      ...(order.userId === null && { ref: { type: 'Order' as const, id: order.id } }),
    });
  }

  /** Texts a guest order's verified phone (accounts get the in-app entry instead); nothing for an account's order. */
  private async smsGuestOrder<K extends TemplateKey>(
    order: OrderRecipient,
    jobId: string,
    template: K,
    data: TemplateData[K],
  ): Promise<void> {
    if (order.userId !== null) return;
    await this.dispatcher.deliver({
      dedupeKey: `${jobId}:${NotificationChannel.SMS}`,
      userId: null,
      template,
      data,
      channel: NotificationChannel.SMS,
      to: order.guestPhone,
      ref: { type: 'Order', id: order.id },
    });
  }

  /** The customer's in-app feed entry for the same event (P6-N.4), linking to the order; guests have no feed. */
  private async inAppOrder<K extends TemplateKey>(
    order: { id: string; userId: string | null },
    jobId: string,
    template: K,
    data: TemplateData[K],
  ): Promise<void> {
    if (order.userId === null) return;
    await this.dispatcher.deliver({
      dedupeKey: `${jobId}:${NotificationChannel.IN_APP}`,
      userId: order.userId,
      template,
      data,
      channel: NotificationChannel.IN_APP,
      to: null,
      ref: { type: 'Order', id: order.id },
    });
  }

  private async emailDirect<K extends TemplateKey>(
    job: DirectNotificationRef & { to: string },
    jobId: string,
    template: K,
    data: TemplateData[K],
  ): Promise<void> {
    const userId = job.userId ?? (await this.userIdByEmail(job.to));
    if (!userId) {
      this.logger.warn(`No email sent: no account for the address | job: ${template} | jobId: ${jobId}`, CONTEXT);
      return;
    }
    await this.dispatcher.deliver({
      dedupeKey: job.dedupeKey ?? `${jobId}:${NotificationChannel.EMAIL}`,
      userId,
      template,
      data,
      channel: NotificationChannel.EMAIL,
      to: job.to,
      idempotencyKey: jobId,
    });
  }

  // Jobs queued before P6-N.1 name only the address; the account's current or pending address finds it.
  private async userIdByEmail(email: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { pendingEmail: email }] },
      select: { id: true },
    });
    return user?.id ?? null;
  }

  // Jobs queued before P6-N.1 name only the phone; the account verifying it holds it as its phone number.
  private async userIdByPhone(phone: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({ where: { phoneNumber: phone }, select: { id: true } });
    return user?.id ?? null;
  }

  private async userIdByOrderNumber(orderNumber: number): Promise<string | null> {
    const order = await this.prisma.order.findUnique({ where: { orderNumber }, select: { userId: true } });
    return order?.userId ?? null;
  }

  // An order hard-deleted since the event (only test cleanups do that) has nobody to notify; retrying cannot help.
  private async findOrder(orderId: string, jobName: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        userId: true,
        currency: true,
        grandTotal: true,
        shippingTotal: true,
        discountTotal: true,
        paymentMethod: true,
        contactEmail: true,
        guestPhone: true,
        user: { select: { email: true } },
        items: { select: { productName: true, quantity: true, lineTotal: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!order) this.logger.warn(`No email sent: order not found | job: ${jobName} | orderId: ${orderId}`, CONTEXT);
    return order;
  }

  // Refunds are never deleted; only test cleanups truncate the ledger under a queued event.
  private async findRefund(refundId: string, jobName: string) {
    const refund = await this.prisma.refund.findUnique({
      where: { id: refundId },
      select: {
        amount: true,
        currency: true,
        reason: true,
        shippingAmount: true,
        lines: { select: { quantity: true, orderItem: { select: { productName: true } } }, orderBy: { id: 'asc' } },
      },
    });
    if (!refund) this.logger.warn(`No email sent: refund not found | job: ${jobName} | refundId: ${refundId}`, CONTEXT);
    return refund;
  }
}
