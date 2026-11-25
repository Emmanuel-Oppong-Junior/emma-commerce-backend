import { Injectable } from '@nestjs/common';
import { NotificationCategory, NotificationChannel, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LoggerService } from '../../commons/logger.service';
import { OutboxService } from '../../outbox/outbox.service';
import { verifiedPhoneOf } from '../../phone-verification/phone-otp';
import { mayDeliver } from '../../notifications/preferences/notification-preferences';
import { ABANDONED_CART_MAX_AGE_HOURS, abandonedCartDecision, AbandonedCartSkip } from './abandoned-cart';

export const ABANDONED_CART_LOCK_KEY = 70_412_009;
/** Carts looked at per run; the rest wait for the next hourly run. */
export const ABANDONED_CART_BATCH = 500;
const HOUR_MS = 60 * 60 * 1000;
const CONTEXT = 'AbandonedCartTask';

export interface AbandonedCartRun {
  reminded: number;
  skipped: Partial<Record<AbandonedCartSkip, number>>;
}

/**
 * Repeatable job (hourly): records one reminder (and its outbox event, which the notifications worker turns into the
 * email and SMS) for each signed-in customer's cart that abandonedCartDecision says to remind about. Runs in one
 * transaction under an advisory lock; the unique (user, cart state) row keeps a state from being reminded twice.
 */
@Injectable()
export class AbandonedCartTask {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly logger: LoggerService,
  ) {}

  async run(now = new Date()): Promise<AbandonedCartRun | null> {
    const run = await this.prisma.$transaction(
      async (tx) => {
        const [{ locked }] = await tx.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(${ABANDONED_CART_LOCK_KEY}::bigint) AS locked`;
        if (!locked) return null;
        const { abandonedCartReminderDelayHours: delayHours } = await tx.store.findFirstOrThrow({
          where: { singleton: true },
          select: { abandonedCartReminderDelayHours: true },
        });
        const result: AbandonedCartRun = { reminded: 0, skipped: {} };
        for (const cart of await this.candidates(tx, now, delayHours)) {
          const decision = abandonedCartDecision(
            {
              lines: cart.items,
              lastOrderAt: cart.user.order[0]?.createdAt ?? null,
              remindedStateHashes: cart.user.abandonedCartReminders.map((reminder) => reminder.cartStateHash),
              lastRemindedAt: cart.user.abandonedCartReminders[0]?.sentAt ?? null,
              hasMarketingConsent: hasConsent(cart.user),
            },
            now,
            delayHours,
          );
          if (!decision.remind) {
            result.skipped[decision.reason] = (result.skipped[decision.reason] ?? 0) + 1;
            continue;
          }
          const reminder = await tx.abandonedCartReminder.create({
            data: { userId: cart.userId, cartStateHash: decision.stateHash, sentAt: now },
            select: { id: true },
          });
          await this.outbox.record(tx, {
            type: 'cart.abandoned_reminder.v1',
            aggregateId: cart.userId,
            payload: { reminderId: reminder.id, userId: cart.userId },
          });
          result.reminded += 1;
        }
        return result;
      },
      { timeout: 60_000 },
    );
    if (run === null) {
      this.logger.log('Skipped: another instance is already sending abandoned-cart reminders', CONTEXT);
      return null;
    }
    this.logger.log(
      `Abandoned-cart reminders | reminded: ${run.reminded} | skipped: ${JSON.stringify(run.skipped)}`,
      CONTEXT,
    );
    return run;
  }

  /**
   * Active customers' carts with a line changed in the reminder window, and what the decision needs about them. Guest
   * carts (P6-G.1) have no account, so no consent, and are never reminded.
   */
  private async candidates(tx: Prisma.TransactionClient, now: Date, delayHours: number) {
    const changedBefore = new Date(now.getTime() - delayHours * HOUR_MS);
    const changedAfter = new Date(now.getTime() - ABANDONED_CART_MAX_AGE_HOURS * HOUR_MS);
    const carts = await tx.cart.findMany({
      where: {
        userId: { not: null },
        user: {
          isActive: true,
          notificationPreferences: { some: { category: NotificationCategory.MARKETING, enabled: true } },
        },
        items: { some: { updatedAt: { gte: changedAfter, lte: changedBefore } } },
      },
      select: {
        userId: true,
        items: { select: { variantId: true, quantity: true, updatedAt: true } },
        user: {
          select: {
            phoneNumber: true,
            phoneVerifiedAt: true,
            phoneVerifiedNumber: true,
            notificationPreferences: {
              where: { category: NotificationCategory.MARKETING, enabled: true },
              select: { channel: true },
            },
            order: { select: { createdAt: true }, orderBy: { createdAt: 'desc' }, take: 1 },
            abandonedCartReminders: {
              select: { cartStateHash: true, sentAt: true },
              orderBy: { sentAt: 'desc' },
            },
          },
        },
      },
      orderBy: { userId: 'asc' },
      take: ABANDONED_CART_BATCH,
    });
    return carts.flatMap(({ userId, user, items }) => (userId && user ? [{ userId, user, items }] : []));
  }
}

function hasConsent(user: {
  phoneNumber: string | null;
  phoneVerifiedAt: Date | null;
  phoneVerifiedNumber: string | null;
  notificationPreferences: { channel: NotificationChannel }[];
}): boolean {
  const phoneVerified = verifiedPhoneOf(user) !== null;
  return user.notificationPreferences.some((pref) =>
    mayDeliver(NotificationCategory.MARKETING, pref.channel, true, phoneVerified),
  );
}
