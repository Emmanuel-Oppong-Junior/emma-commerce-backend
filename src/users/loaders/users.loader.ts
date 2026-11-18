import { Injectable, Scope } from '@nestjs/common';
import * as DataLoader from 'dataloader';
import { User } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class UsersLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches user lookups by ID in a single request.
   * Prevents N+1 queries when resolving the `user` field on Review, Order, etc.
   */
  readonly loader = new DataLoader<string, User | null>(
    async (userIds: readonly string[]) => {
      const ids = [...userIds];

      const users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
      });

      const usersById = new Map<string, User>();
      for (const user of users) usersById.set(user.id, user);

      return ids.map((id) => usersById.get(id) ?? null);
    },
    { cache: false },
  );
}
