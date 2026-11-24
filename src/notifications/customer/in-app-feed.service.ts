import { BadRequestException, Injectable } from '@nestjs/common';
import { Notification, NotificationChannel, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export const FEED_PAGE_MAX = 50;
/** How many ids one markNotificationsRead call may name. */
export const MARK_READ_MAX = 100;

export interface FeedPage {
  nodes: Notification[];
  totalCount: number;
  hasNextPage: boolean;
}

/**
 * The customer's in-app notification feed (P6-N.4): their IN_APP Notification rows, newest first. Every query and
 * update is scoped to the caller's user id, so another user's ids are simply not found (nothing to tell apart).
 */
@Injectable()
export class InAppFeedService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string, first: number, after: string | undefined, unreadOnly: boolean): Promise<FeedPage> {
    const where: Prisma.NotificationWhereInput = {
      userId,
      channel: NotificationChannel.IN_APP,
      ...(unreadOnly ? { readAt: null } : {}),
    };
    const take = Math.min(first, FEED_PAGE_MAX);
    const cursor = after ? await this.cursorOf(userId, after) : null;
    if (after && !cursor) throw new BadRequestException(`Unknown cursor "${after}"`);
    const [rows, totalCount] = await Promise.all([
      this.prisma.notification.findMany({
        where: cursor
          ? {
              ...where,
              OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
            }
          : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return { nodes: rows.slice(0, take), totalCount, hasNextPage: rows.length > take };
  }

  unreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, channel: NotificationChannel.IN_APP, readAt: null } });
  }

  /** Marks the caller's listed unread notifications read; ids of others or already read are ignored. */
  async markRead(userId: string, ids: string[]): Promise<number> {
    if (ids.length > MARK_READ_MAX) {
      throw new BadRequestException(`At most ${MARK_READ_MAX} notifications can be marked read at once`);
    }
    const { count } = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }

  async markAllRead(userId: string): Promise<number> {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, channel: NotificationChannel.IN_APP, readAt: null },
      data: { readAt: new Date() },
    });
    return count;
  }

  // Another user's notification is not a cursor: it is unknown here.
  private cursorOf(userId: string, id: string) {
    return this.prisma.notification.findFirst({
      where: { id, userId, channel: NotificationChannel.IN_APP },
      select: { id: true, createdAt: true },
    });
  }
}
