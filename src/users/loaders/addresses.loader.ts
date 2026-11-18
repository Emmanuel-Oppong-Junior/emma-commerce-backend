import { Injectable, Scope } from '@nestjs/common';
import DataLoader = require('dataloader');
import { Address } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable({ scope: Scope.REQUEST })
export class AddressesLoader {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Batches address lookups by user ID in a single request.
   * Prevents N+1 queries when resolving the `addresses` field on User.
   */
  readonly loader = new DataLoader<string, Address[]>(
    async (userIds: readonly string[]) => {
      const ids = [...userIds];

      const addresses = await this.prisma.address.findMany({
        where: { userId: { in: ids } },
        orderBy: { createdAt: 'desc' },
      });

      const addressesByUserId = new Map<string, Address[]>();
      for (const id of ids) addressesByUserId.set(id, []);
      for (const address of addresses) {
        addressesByUserId.get(address.userId)?.push(address);
      }

      return ids.map((id) => addressesByUserId.get(id) ?? []);
    },
    { cache: false },
  );
}
