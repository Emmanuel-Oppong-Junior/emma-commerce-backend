import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ConsentAction,
  ConsentEvent,
  ConsentSource,
  NotificationCategory,
  NotificationChannel,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { verifiedPhoneOf } from '../../phone-verification/phone-otp';
import { PreferenceView, preferenceMatrix, preferenceRefusal } from '../preferences/notification-preferences';

export interface PreferenceChange {
  category: NotificationCategory;
  channel: NotificationChannel;
  enabled: boolean;
  source: ConsentSource;
  /** The staff member recording it on the customer's request (STAFF_REQUEST). */
  actorId?: string;
}

const REFUSAL_MESSAGES = {
  TRANSACTIONAL_ALWAYS_ON: 'Transactional messages (codes, receipts, order updates) cannot be switched off',
  CHANNEL_NOT_AVAILABLE: 'This category is not sent on that channel',
  PHONE_NOT_VERIFIED: 'Verify your phone number before opting in to marketing SMS',
} as const;

/**
 * Customers' notification preferences and the consent ledger (P6-N.1). Marketing is opt-in per channel; every change
 * of a marketing choice writes the preference and one ConsentEvent in one transaction, under a lock on the user row so
 * concurrent changes cannot record a change that did not happen. Withdrawal is effective at once: senders read the
 * preference when sending.
 */
@Injectable()
export class NotificationPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<PreferenceView[]> {
    const stored = await this.prisma.notificationPreference.findMany({ where: { userId } });
    return preferenceMatrix(stored);
  }

  /**
   * Applies a change and returns the whole matrix. A no-op change (already in that state) records nothing.
   * @throws BadRequestException with reason TRANSACTIONAL_ALWAYS_ON, CHANNEL_NOT_AVAILABLE or PHONE_NOT_VERIFIED.
   */
  async update(userId: string, change: PreferenceChange): Promise<PreferenceView[]> {
    await this.prisma.$transaction(async (tx) => {
      const user = await this.lockUser(tx, userId);
      const refusal = preferenceRefusal(
        change.category,
        change.channel,
        change.enabled,
        verifiedPhoneOf(user) !== null,
      );
      if (refusal) {
        throw new BadRequestException({ message: REFUSAL_MESSAGES[refusal], extensions: { reason: refusal } });
      }
      if (change.category !== NotificationCategory.MARKETING) return;
      const key = { userId, category: change.category, channel: change.channel };
      const current = await tx.notificationPreference.findUnique({ where: { userId_category_channel: key } });
      if ((current?.enabled ?? false) === change.enabled) return;
      await tx.notificationPreference.upsert({
        where: { userId_category_channel: key },
        create: { ...key, enabled: change.enabled },
        update: { enabled: change.enabled },
      });
      await tx.consentEvent.create({
        data: {
          ...key,
          action: change.enabled ? ConsentAction.GRANTED : ConsentAction.WITHDRAWN,
          source: change.source,
          actorId: change.actorId ?? null,
        },
      });
    });
    return this.list(userId);
  }

  /** The customer's consent ledger, newest first. */
  async consentHistory(userId: string): Promise<ConsentEvent[]> {
    await this.findUser(this.prisma, userId);
    return this.prisma.consentEvent.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw`SELECT 1 FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
    return this.findUser(tx, userId);
  }

  private async findUser(db: Prisma.TransactionClient, userId: string) {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, phoneNumber: true, phoneVerifiedAt: true, phoneVerifiedNumber: true },
    });
    if (!user) throw new NotFoundException(`User "${userId}" not found`);
    return user;
  }
}
