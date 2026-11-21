import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { insertRepricedChanges, PriceHistoryRepository } from './price-history.repository';

describe('PriceHistoryRepository', () => {
  const prisma = { priceChange: { findMany: jest.fn(), count: jest.fn() } };
  const repository = new PriceHistoryRepository(prisma as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.priceChange.findMany.mockResolvedValue([]);
    prisma.priceChange.count.mockResolvedValue(0);
  });

  describe('append', () => {
    it('writes every change in the store currency with the origin, on the transaction', async () => {
      const tx = {
        store: { findUniqueOrThrow: jest.fn().mockResolvedValue({ currency: 'GHS' }) },
        priceChange: { createMany: jest.fn().mockResolvedValue({ count: 2 }) },
      };
      const origin = { source: 'VARIANT_CREATED' as const, actorId: 'admin1', reason: null };

      await repository.append(
        tx as unknown as Prisma.TransactionClient,
        'v1',
        [
          { field: 'BASE_PRICE', oldValue: null, newValue: new Prisma.Decimal('10.00') },
          { field: 'PRICE', oldValue: null, newValue: new Prisma.Decimal('11.50') },
        ],
        origin,
      );

      expect(tx.store.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { singleton: true },
        select: { currency: true },
      });
      expect(tx.priceChange.createMany).toHaveBeenCalledWith({
        data: [
          {
            variantId: 'v1',
            field: 'BASE_PRICE',
            oldValue: null,
            newValue: new Prisma.Decimal('10.00'),
            currency: 'GHS',
            ...origin,
          },
          {
            variantId: 'v1',
            field: 'PRICE',
            oldValue: null,
            newValue: new Prisma.Decimal('11.50'),
            currency: 'GHS',
            ...origin,
          },
        ],
      });
    });
  });

  describe('findPage', () => {
    it('filters by product through the variant and by [from, to), newest first', async () => {
      const from = new Date('2026-11-01T00:00:00.000Z');
      const to = new Date('2026-12-01T00:00:00.000Z');

      await repository.findPage({ productId: 'p1', from, to }, { take: 11, after: 'pc9' });

      const where = { variantId: undefined, variant: { productId: 'p1' }, createdAt: { gte: from, lt: to } };
      expect(prisma.priceChange.findMany).toHaveBeenCalledWith({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 11,
        cursor: { id: 'pc9' },
        skip: 1,
      });
      expect(prisma.priceChange.count).toHaveBeenCalledWith({ where });
    });

    it('lists every change without filters', async () => {
      await repository.findPage({}, { take: 51 });

      expect(prisma.priceChange.findMany).toHaveBeenCalledWith({
        where: { variantId: undefined },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 51,
      });
    });
  });

  describe('insertRepricedChanges', () => {
    it('binds the origin as parameters, never as SQL text', () => {
      const fragment = insertRepricedChanges({ source: 'TAX_RATE_CHANGE', actorId: "o'brien", reason: "it's due" });

      expect(fragment.sql).not.toContain("o'brien");
      expect(fragment.values).toEqual(['TAX_RATE_CHANGE', "it's due", "o'brien"]);
      expect(fragment.sql.replace(/\s+/g, ' ')).toContain('FROM repriced r');
    });
  });
});
