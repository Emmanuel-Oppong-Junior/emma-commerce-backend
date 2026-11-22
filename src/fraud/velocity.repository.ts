import { Injectable, NotFoundException } from '@nestjs/common';
import { OrderReviewFlag, OrderStatus, Prisma, VelocityLimit, VelocityRule } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { VelocityHit, VelocityLimits } from './velocity-rules';

export interface FlaggedOrderRecord {
  id: string;
  orderNumber: number;
  userId: string;
  status: OrderStatus;
  grandTotal: Prisma.Decimal;
  currency: string;
  createdAt: Date;
  reviewFlags: OrderReviewFlag[];
}

const FLAGGED_ORDER_SELECT = {
  id: true,
  orderNumber: true,
  userId: true,
  status: true,
  grandTotal: true,
  currency: true,
  createdAt: true,
} as const;

@Injectable()
export class VelocityRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findLimits(db: Prisma.TransactionClient = this.prisma): Promise<VelocityLimit[]> {
    return db.velocityLimit.findMany({ where: { store: { singleton: true } } });
  }

  async upsertLimits(
    tx: Prisma.TransactionClient,
    updates: readonly ({ rule: VelocityRule } & VelocityLimits)[],
    actorId: string,
  ): Promise<string> {
    const store = await tx.store.findFirstOrThrow({ where: { singleton: true }, select: { id: true } });
    for (const { rule, softLimit, hardLimit } of updates) {
      await tx.velocityLimit.upsert({
        where: { storeId_rule: { storeId: store.id, rule } },
        create: { storeId: store.id, rule, softLimit, hardLimit, updatedById: actorId },
        update: { softLimit, hardLimit, updatedById: actorId },
      });
    }
    return store.id;
  }

  /** Raises one open flag per rule on the order; a rule already flagged and not yet cleared is left as it is. */
  async flagOrder(
    orderId: string,
    hits: readonly VelocityHit[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    if (hits.length === 0) return 0;
    const { count } = await db.orderReviewFlag.createMany({
      data: hits.map(({ rule, level, count: hitCount, limit }) => ({ orderId, rule, level, count: hitCount, limit })),
      skipDuplicates: true,
    });
    return count;
  }

  /** Orders with at least one open flag, newest flag first, with their open flags. */
  async findFlaggedOrders(take: number): Promise<FlaggedOrderRecord[]> {
    const open = { clearedAt: null };
    return this.prisma.order.findMany({
      where: { reviewFlags: { some: open } },
      select: { ...FLAGGED_ORDER_SELECT, reviewFlags: { where: open, orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** Clears every open flag on the order; NOT_FOUND when it has none. Returns the cleared flags. */
  async clearFlags(
    tx: Prisma.TransactionClient,
    orderId: string,
    actorId: string,
    note: string,
  ): Promise<OrderReviewFlag[]> {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const open = await tx.orderReviewFlag.findMany({ where: { orderId, clearedAt: null }, select: { id: true } });
    if (open.length === 0) throw new NotFoundException(`Order "${orderId}" has no open review flags`);
    const ids = open.map(({ id }) => id);
    await tx.orderReviewFlag.updateMany({
      where: { id: { in: ids } },
      data: { clearedAt: new Date(), clearedById: actorId, clearNote: note },
    });
    return tx.orderReviewFlag.findMany({ where: { id: { in: ids } }, orderBy: { createdAt: 'asc' } });
  }
}
