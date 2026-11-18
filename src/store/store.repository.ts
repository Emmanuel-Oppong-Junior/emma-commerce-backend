import { Injectable } from '@nestjs/common';
import { Currency, Prisma, Store } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MISSING_STORE = 'No Store row exists; apply the database migrations';
// findFirst, not findUnique: Prisma batches concurrent findUnique calls into an `in` filter, which a Boolean key rejects.
const THE_STORE = { singleton: true } as const;

@Injectable()
export class StoreRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(db: Prisma.TransactionClient = this.prisma): Promise<Store> {
    const store = await db.store.findFirst({ where: THE_STORE });
    if (!store) throw new Error(MISSING_STORE);
    return store;
  }

  async findCurrency(db: Prisma.TransactionClient = this.prisma): Promise<Currency> {
    const store = await db.store.findFirst({ where: THE_STORE, select: { currency: true } });
    if (!store) throw new Error(MISSING_STORE);
    return store.currency;
  }

  async update(data: Prisma.StoreUpdateInput, tx: Prisma.TransactionClient): Promise<Store> {
    return tx.store.update({ where: THE_STORE, data });
  }
}
