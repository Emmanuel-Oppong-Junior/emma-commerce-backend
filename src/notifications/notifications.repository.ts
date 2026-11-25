import { Injectable } from '@nestjs/common';
import {
  Notification,
  NotificationCategory,
  NotificationChannel,
  NotificationStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { verifiedPhoneOf } from '../phone-verification/phone-otp';
import { DEFAULT_LOCALE, InAppContent, TemplateKey, templateDefinition } from './templates/templates';

/** Why a notification was skipped or failed; stored in Notification.errorCode. */
export type NotificationErrorCode = 'NO_CONSENT' | 'NO_ADDRESS' | 'NOT_CONFIGURED' | 'PROVIDER_ERROR' | 'QUEUE_ERROR';

export interface NotificationKey {
  dedupeKey: string;
  userId: string;
  template: TemplateKey;
  channel: NotificationChannel;
}

/** The Notification rows: one per message, written QUEUED and moved on by the channel sender. */
@Injectable()
export class NotificationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The row for `dedupeKey`, created QUEUED (with the template's current version and category) when missing. */
  findOrCreate({ dedupeKey, userId, template, channel }: NotificationKey): Promise<Notification> {
    const { version, category } = templateDefinition(template);
    return this.prisma.notification.upsert({
      where: { dedupeKey },
      create: {
        dedupeKey,
        userId,
        channel,
        category,
        templateKey: template,
        templateVersion: version,
        locale: DEFAULT_LOCALE,
      },
      update: {},
    });
  }

  async markSent(id: string, providerMessageId: string | null, providerStatus: string | null = null): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.SENT,
        providerMessageId,
        providerStatus,
        errorCode: null,
        sentAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  }

  /** An in-app notification is delivered by storing its text in the feed. */
  async markSentInApp(id: string, content: InAppContent, ref?: { type: string; id: string }): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: {
        status: NotificationStatus.SENT,
        title: content.title,
        body: content.body,
        refType: ref?.type ?? null,
        refId: ref?.id ?? null,
        errorCode: null,
        sentAt: new Date(),
        attempts: { increment: 1 },
      },
    });
  }

  async markSkipped(id: string, errorCode: NotificationErrorCode): Promise<void> {
    await this.prisma.notification.update({ where: { id }, data: { status: NotificationStatus.SKIPPED, errorCode } });
  }

  async markFailed(id: string, errorCode: NotificationErrorCode, attempted: boolean): Promise<void> {
    await this.prisma.notification.update({
      where: { id },
      data: { status: NotificationStatus.FAILED, errorCode, ...(attempted ? { attempts: { increment: 1 } } : {}) },
    });
  }

  /** Whether the customer consented to marketing on the channel, and whether their phone is verified. */
  async consentFacts(
    userId: string,
    channel: NotificationChannel,
  ): Promise<{ marketingConsent: boolean; phoneVerified: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phoneNumber: true,
        phoneVerifiedAt: true,
        phoneVerifiedNumber: true,
        notificationPreferences: {
          where: { category: NotificationCategory.MARKETING, channel },
          select: { enabled: true },
        },
      },
    });
    return {
      marketingConsent: user?.notificationPreferences[0]?.enabled ?? false,
      phoneVerified: !!user && verifiedPhoneOf(user) !== null,
    };
  }
}
