import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';
import { EmailService } from './email/email.service';
import { NotificationsService } from './notifications.service';
import { formatOpeningHours } from '../pickup-locations/opening-hours';
import { normaliseGhanaPhone } from '../commons/phone/ghana-phone';
import { ReadyForPickupEmail } from './email/templates/email.templates';

const CONTEXT = 'ReadyForPickupNotifier';

/**
 * Tells the customer their pickup order is ready (P5-E.1): an email to the account and an SMS to the order's contact
 * phone, with the pickup point, its opening hours and the order number. The SMS is its own job keyed by the event's
 * job id, so a retry of this job (after the email went out) queues it once; both sends are idempotent per job id.
 */
@Injectable()
export class ReadyForPickupNotifier {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly logger: LoggerService,
  ) {}

  async notify(orderId: string, idempotencyKey: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        contactPhone: true,
        user: { select: { email: true } },
        pickupLocation: { include: { openingHours: true } },
      },
    });
    // An order hard-deleted since the event (only test cleanups do that) has nobody to notify; retrying cannot help.
    if (!order?.pickupLocation) {
      this.logger.warn(`No pickup notice sent: pickup order not found | orderId: ${orderId}`, CONTEXT);
      return;
    }
    const location = order.pickupLocation;
    const notice: ReadyForPickupEmail = {
      orderNumber: order.orderNumber,
      pickupName: location.name,
      address: `${location.address}, ${location.city}`,
      hours: formatOpeningHours(location.openingHours),
      contactPhone: location.contactPhone,
      instructions: location.instructions,
    };
    await this.email.sendReadyForPickupEmail(order.user.email, order.id, notice, idempotencyKey);
    const to = normaliseGhanaPhone(order.contactPhone);
    if (!to) {
      this.logger.warn(`No pickup SMS sent: the contact phone is not a Ghana number | orderId: ${orderId}`, CONTEXT);
      return;
    }
    await this.notifications.queueReadyForPickupSms(`${idempotencyKey}-sms`, { to, notice });
  }
}
