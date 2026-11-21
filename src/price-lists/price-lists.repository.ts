import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PriceListEntryDefinition } from './price-list-definition';

const WITH_GROUPS = {
  customerGroups: { select: { id: true } },
  _count: { select: { entries: true } },
} satisfies Prisma.PriceListInclude;

export type PriceListWithGroups = Prisma.PriceListGetPayload<{ include: typeof WITH_GROUPS }>;

const ENTRY_WITH_TIERS = { tiers: { orderBy: { minQuantity: 'asc' } } } satisfies Prisma.PriceListEntryInclude;

export type PriceListEntryWithTiers = Prisma.PriceListEntryGetPayload<{ include: typeof ENTRY_WITH_TIERS }>;

export type PricingPriceListRow = Prisma.PriceListGetPayload<{
  include: { customerGroups: { select: { id: true } }; entries: { include: typeof ENTRY_WITH_TIERS } };
}>;

@Injectable()
export class PriceListsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: { isActive?: boolean }): Promise<PriceListWithGroups[]> {
    return this.prisma.priceList.findMany({
      where: { isActive: filter.isActive },
      include: WITH_GROUPS,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, db: Prisma.TransactionClient = this.prisma): Promise<PriceListWithGroups | null> {
    return db.priceList.findUnique({ where: { id }, include: WITH_GROUPS });
  }

  async create(data: Prisma.PriceListCreateInput, tx: Prisma.TransactionClient): Promise<PriceListWithGroups> {
    return tx.priceList.create({ data, include: WITH_GROUPS });
  }

  async update(
    id: string,
    data: Prisma.PriceListUpdateInput,
    tx: Prisma.TransactionClient,
  ): Promise<PriceListWithGroups> {
    return tx.priceList.update({ where: { id }, data, include: WITH_GROUPS });
  }

  async delete(id: string, tx: Prisma.TransactionClient): Promise<PriceListWithGroups> {
    return tx.priceList.delete({ where: { id }, include: WITH_GROUPS });
  }

  async findEntryPage(
    priceListId: string,
    page: { take: number; after?: string },
  ): Promise<[PriceListEntryWithTiers[], number]> {
    return Promise.all([
      this.prisma.priceListEntry.findMany({
        where: { priceListId },
        include: ENTRY_WITH_TIERS,
        orderBy: { variantId: 'asc' },
        take: page.take,
        ...(page.after && { cursor: { priceListId_variantId: { priceListId, variantId: page.after } }, skip: 1 }),
      }),
      this.prisma.priceListEntry.count({ where: { priceListId } }),
    ]);
  }

  async findEntries(
    tx: Prisma.TransactionClient,
    priceListId: string,
    variantIds: readonly string[],
  ): Promise<PriceListEntryWithTiers[]> {
    return tx.priceListEntry.findMany({
      where: { priceListId, variantId: { in: [...variantIds] } },
      include: ENTRY_WITH_TIERS,
      orderBy: { variantId: 'asc' },
    });
  }

  /** Writes each entry over its variant's entry in the list (its tiers replaced), on the caller's tx. */
  async upsertEntries(
    tx: Prisma.TransactionClient,
    priceListId: string,
    entries: readonly PriceListEntryDefinition[],
  ): Promise<void> {
    for (const { variantId, price, minQuantity, tiers } of entries) {
      const tierRows = tiers.map((tier) => ({ minQuantity: tier.minQuantity, price: tier.price }));
      await tx.priceListEntry.upsert({
        where: { priceListId_variantId: { priceListId, variantId } },
        create: { priceListId, variantId, price, minQuantity, tiers: { create: tierRows } },
        update: { price, minQuantity, tiers: { deleteMany: {}, create: tierRows } },
      });
    }
  }

  async deleteEntries(tx: Prisma.TransactionClient, priceListId: string, variantIds: readonly string[]): Promise<void> {
    await tx.priceListEntry.deleteMany({ where: { priceListId, variantId: { in: [...variantIds] } } });
  }

  /**
   * The active lists in their schedule at `now` open to one of the groups, with their entries for the variants, read
   * on `db` (the order transaction at placement). The pricing engine checks the same conditions again.
   */
  async findForPricing(
    variantIds: readonly string[],
    groupIds: readonly string[],
    now: Date,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<PricingPriceListRow[]> {
    return db.priceList.findMany({
      where: {
        isActive: true,
        customerGroups: { some: { id: { in: [...groupIds] } } },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
        entries: { some: { variantId: { in: [...variantIds] } } },
      },
      include: {
        customerGroups: { select: { id: true } },
        entries: { where: { variantId: { in: [...variantIds] } }, include: ENTRY_WITH_TIERS },
      },
    });
  }

  async missingVariants(ids: readonly string[]): Promise<string[]> {
    const found = await this.prisma.variant.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const existing = new Set(found.map(({ id }) => id));
    return ids.filter((id) => !existing.has(id));
  }

  async missingCustomerGroups(ids: readonly string[]): Promise<string[]> {
    const found = await this.prisma.customerGroup.findMany({ where: { id: { in: [...ids] } }, select: { id: true } });
    const existing = new Set(found.map(({ id }) => id));
    return ids.filter((id) => !existing.has(id));
  }
}
