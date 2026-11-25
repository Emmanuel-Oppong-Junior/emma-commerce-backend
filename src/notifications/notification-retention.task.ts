import { Injectable } from '@nestjs/common';
import { NotificationChannel } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LoggerService } from '../commons/logger.service';

export const NOTIFICATION_RETENTION_LOCK_KEY = 70_412_008;
/** The in-app feed shows the last 90 days. */
export const IN_APP_RETENTION_DAYS = 90;
/** Email and SMS delivery records are kept longer, for "I never got it" questions and disputes. */
export const DELIVERY_RECORD_RETENTION_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTEXT = 'NotificationRetentionTask';

export interface RetentionRun {
  inApp: number;
  deliveryRecords: number;
}

/** Repeatable job (daily): deletes Notification rows past their retention, under an advisory lock. */
@Injectable()
export class NotificationRetentionTask {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: LoggerService,
  ) {}

  async purge(now = new Date()): Promise<RetentionRun | null> {
    const run = await this.prisma.$transaction(async (tx) => {
      const [{ locked }] = await tx.$queryRaw<
        { locked: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(${NOTIFICATION_RETENTION_LOCK_KEY}::bigint) AS locked`;
      if (!locked) return null;
      const inApp = await tx.notification.deleteMany({
        where: {
          channel: NotificationChannel.IN_APP,
          createdAt: { lt: new Date(now.getTime() - IN_APP_RETENTION_DAYS * DAY_MS) },
        },
      });
      const deliveryRecords = await tx.notification.deleteMany({
        where: {
          channel: { not: NotificationChannel.IN_APP },
          createdAt: { lt: new Date(now.getTime() - DELIVERY_RECORD_RETENTION_DAYS * DAY_MS) },
        },
      });
      return { inApp: inApp.count, deliveryRecords: deliveryRecords.count };
    });
    if (run === null) {
      this.logger.log('Skipped: another instance is already purging notifications', CONTEXT);
      return null;
    }
    this.logger.log(`Notifications purged | inApp: ${run.inApp} | deliveryRecords: ${run.deliveryRecords}`, CONTEXT);
    return run;
  }
}
