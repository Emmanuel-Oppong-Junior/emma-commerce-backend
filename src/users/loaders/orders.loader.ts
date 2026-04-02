import { Injectable, Scope } from '@nestjs/common';
import DataLoader = require('dataloader');
import { Order, OrderItem } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type OrderWithItems = Order & { items: OrderItem[] };

@Injectable({ scope: Scope.REQUEST })
export class OrdersLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches order lookups by user ID in a single request.
   * Prevents N+1 queries when resolving the `orders` field on User.
   */
  readonly loader = new DataLoader<string, OrderWithItems[]>(
    async (userIds: readonly string[]) => {
      const ids = [...userIds];

      const orders = (await this.prisma.order.findMany({
        where: { userId: { in: ids }, deleted: false },
        include: { items: true },
        orderBy: { createdAt: 'desc' },
      })) as unknown as OrderWithItems[];

      const ordersByUserId = new Map<string, OrderWithItems[]>();
      for (const id of ids) ordersByUserId.set(id, []);
      for (const order of orders) {
        ordersByUserId.get(order.userId)?.push(order);
      }

      return ids.map((id) => ordersByUserId.get(id) ?? []);
    },
    { cache: false },
  );
}
