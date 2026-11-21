import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../commons/audit.service';
import { PricingPriceList } from '../pricing/price';
import { StoreService } from '../store/store.service';
import {
  CreatePriceListInput,
  PriceListEntryInput,
  RemovePriceListEntriesInput,
  SetPriceListEntriesInput,
  UpdatePriceListInput,
} from './dto/price-list.input';
import { PriceList, PriceListEntry, PriceListEntryPage } from './entities/price-list.entity';
import { priceListEntriesError, PriceListEntryDefinition } from './price-list-definition';
import {
  PriceListEntryWithTiers,
  PriceListsRepository,
  PriceListWithGroups,
  PricingPriceListRow,
} from './price-lists.repository';

const AUDITED_FIELDS = [
  'name',
  'description',
  'currency',
  'isActive',
  'startsAt',
  'endsAt',
  'priority',
  'allowPromotions',
] as const satisfies readonly (keyof PriceListWithGroups)[];

const REQUIRED_FIELDS = [
  'name',
  'isActive',
  'priority',
  'allowPromotions',
] as const satisfies readonly (keyof UpdatePriceListInput)[];

function toEntity({ customerGroups, _count, ...list }: PriceListWithGroups): PriceList {
  return { ...list, customerGroupIds: customerGroups.map(({ id }) => id), entryCount: _count.entries };
}

function toEntryEntity(entry: PriceListEntryWithTiers): PriceListEntry {
  return {
    variantId: entry.variantId,
    price: entry.price,
    minQuantity: entry.minQuantity,
    tiers: entry.tiers.map(({ minQuantity, price }) => ({ minQuantity, price })),
    updatedAt: entry.updatedAt,
  };
}

function toDefinition(entry: PriceListEntryInput): PriceListEntryDefinition {
  return {
    variantId: entry.variantId,
    price: entry.price,
    minQuantity: entry.minQuantity,
    tiers: entry.tiers.map(({ minQuantity, price }) => ({ minQuantity, price })),
  };
}

function auditEntry(entry: PriceListEntryDefinition | PriceListEntryWithTiers) {
  return {
    price: entry.price.toFixed(2),
    minQuantity: entry.minQuantity,
    tiers: entry.tiers.map((tier) => ({ minQuantity: tier.minQuantity, price: tier.price.toFixed(2) })),
  };
}

export function toPricingPriceList(row: PricingPriceListRow): PricingPriceList {
  return {
    id: row.id,
    currency: row.currency,
    isActive: row.isActive,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    priority: row.priority,
    allowPromotions: row.allowPromotions,
    customerGroupIds: row.customerGroups.map(({ id }) => id),
    createdAt: row.createdAt,
    entries: row.entries.map((entry) => ({
      variantId: entry.variantId,
      minQuantity: entry.minQuantity,
      price: entry.price,
      tiers: entry.tiers.map(({ minQuantity, price }) => ({ minQuantity, price })),
    })),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * B2B price lists (P2-W.1). Every change is audited in its transaction, entries with their before and after prices:
 * list prices are not Variant prices, so they stay out of the append-only PriceChange history (ADR-0005 §6).
 */
@Injectable()
export class PriceListsService {
  constructor(
    private readonly repository: PriceListsRepository,
    private readonly auditService: AuditService,
    private readonly storeService: StoreService,
  ) {}

  async findAll(filter: { isActive?: boolean }): Promise<PriceList[]> {
    return (await this.repository.findAll(filter)).map(toEntity);
  }

  async findOne(id: string): Promise<PriceList> {
    return toEntity(await this.findOrThrow(id));
  }

  async getEntries(priceListId: string, first: number, after?: string): Promise<PriceListEntryPage> {
    const [rows, totalCount] = await this.repository.findEntryPage(priceListId, { take: first + 1, after });
    return { nodes: rows.slice(0, first).map(toEntryEntity), totalCount, hasNextPage: rows.length > first };
  }

  async create(input: CreatePriceListInput, actorId: string): Promise<PriceList> {
    const { customerGroupIds: requestedGroups, ...fields } = input;
    const customerGroupIds = [...new Set(requestedGroups)];
    this.assertSchedule(input.startsAt ?? null, input.endsAt ?? null);
    await this.assertCustomerGroupsExist(customerGroupIds);
    const currency = await this.storeService.getCurrency();
    const created = await this.nameMustBeFree(input.name, () =>
      this.auditService.record(
        (tx) =>
          this.repository.create(
            {
              ...fields,
              currency,
              ...(customerGroupIds.length > 0 && {
                customerGroups: { connect: customerGroupIds.map((id) => ({ id })) },
              }),
            },
            tx,
          ),
        (list) => ({
          entity: 'PriceList',
          entityId: list.id,
          action: 'CREATE',
          userId: actorId,
          details: { after: fieldValues(list, AUDITED_FIELDS), customerGroupIds },
        }),
      ),
    );
    return toEntity(created);
  }

  async update(id: string, input: UpdatePriceListInput, actorId: string): Promise<PriceList> {
    const existing = await this.findOrThrow(id);
    if (Object.values(input).every((value) => value === undefined)) {
      throw new BadRequestException('At least one field must be provided for update');
    }
    const cleared = REQUIRED_FIELDS.filter((field) => input[field] === null);
    if (cleared.length > 0) throw new BadRequestException(`${cleared.join(', ')} cannot be null`);
    const { customerGroupIds: requestedGroups, ...fields } = input;
    const customerGroupIds = requestedGroups && [...new Set(requestedGroups)];
    const kept = <T>(given: T | undefined, stored: T) => (given === undefined ? stored : given);
    this.assertSchedule(kept(input.startsAt, existing.startsAt), kept(input.endsAt, existing.endsAt));
    if (customerGroupIds) await this.assertCustomerGroupsExist(customerGroupIds);
    const updated = await this.nameMustBeFree(input.name ?? existing.name, () =>
      this.auditService.record(
        (tx) =>
          this.repository.update(
            id,
            {
              ...fields,
              ...(customerGroupIds && {
                customerGroups: { set: customerGroupIds.map((groupId) => ({ id: groupId })) },
              }),
            } as Prisma.PriceListUpdateInput,
            tx,
          ),
        (after) => ({
          entity: 'PriceList',
          entityId: id,
          action: 'UPDATE',
          userId: actorId,
          details: {
            changes: fieldChanges(existing, after, AUDITED_FIELDS),
            ...(customerGroupIds && { customerGroupIds }),
          },
        }),
      ),
    );
    return toEntity(updated);
  }

  /** Deletes a list and its entries. Orders keep their prices: they store the list id only as a snapshot. */
  async delete(id: string, actorId: string): Promise<PriceList> {
    await this.findOrThrow(id);
    const deleted = await this.auditService.record(
      (tx) => this.repository.delete(id, tx),
      (before) => ({
        entity: 'PriceList',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: {
          before: fieldValues(before, AUDITED_FIELDS),
          customerGroupIds: before.customerGroups.map((group) => group.id),
          entryCount: before._count.entries,
        },
      }),
    );
    return toEntity(deleted);
  }

  /** Writes each entry over its variant's entry in the list, auditing each variant's price before and after. */
  async setEntries(input: SetPriceListEntriesInput, actorId: string): Promise<PriceList> {
    await this.findOrThrow(input.priceListId);
    const entries = input.entries.map(toDefinition);
    const error = priceListEntriesError(entries);
    if (error) throw new BadRequestException(error);
    const variantIds = entries.map((entry) => entry.variantId);
    const missing = await this.repository.missingVariants(variantIds);
    if (missing.length > 0) throw new BadRequestException(`Unknown variant ids: ${missing.join(', ')}`);
    await this.auditService.record(
      async (tx) => {
        const before = await this.repository.findEntries(tx, input.priceListId, variantIds);
        await this.repository.upsertEntries(tx, input.priceListId, entries);
        return new Map(before.map((entry) => [entry.variantId, entry]));
      },
      (before) => ({
        entity: 'PriceList',
        entityId: input.priceListId,
        action: 'UPDATE',
        userId: actorId,
        details: {
          setEntries: entries.map((entry) => {
            const previous = before.get(entry.variantId);
            return {
              variantId: entry.variantId,
              before: previous ? auditEntry(previous) : null,
              after: auditEntry(entry),
            };
          }),
        },
      }),
    );
    return this.findOne(input.priceListId);
  }

  async removeEntries(input: RemovePriceListEntriesInput, actorId: string): Promise<PriceList> {
    await this.findOrThrow(input.priceListId);
    const variantIds = [...new Set(input.variantIds)];
    await this.auditService.record(
      async (tx) => {
        const removed = await this.repository.findEntries(tx, input.priceListId, variantIds);
        await this.repository.deleteEntries(tx, input.priceListId, variantIds);
        return removed;
      },
      (removed) => ({
        entity: 'PriceList',
        entityId: input.priceListId,
        action: 'UPDATE',
        userId: actorId,
        details: {
          removeEntries: removed.map((entry) => ({ variantId: entry.variantId, before: auditEntry(entry) })),
        },
      }),
    );
    return this.findOne(input.priceListId);
  }

  /**
   * The candidate price lists for these variants and a customer in these groups (none without groups), read on `db`
   * (the order transaction at placement).
   */
  async findForPricing(
    variantIds: readonly string[],
    groupIds: readonly string[],
    now: Date,
    db?: Prisma.TransactionClient,
  ): Promise<PricingPriceList[]> {
    if (groupIds.length === 0 || variantIds.length === 0) return [];
    return (await this.repository.findForPricing(variantIds, groupIds, now, db)).map(toPricingPriceList);
  }

  private assertSchedule(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt <= startsAt) throw new BadRequestException('endsAt must be after startsAt');
  }

  private async assertCustomerGroupsExist(ids: string[]): Promise<void> {
    const missing = await this.repository.missingCustomerGroups(ids);
    if (missing.length > 0) throw new BadRequestException(`Unknown customer group ids: ${missing.join(', ')}`);
  }

  private async findOrThrow(id: string): Promise<PriceListWithGroups> {
    const list = await this.repository.findById(id);
    if (!list) throw new NotFoundException(`Price list "${id}" not found`);
    return list;
  }

  private async nameMustBeFree<T>(name: string, write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException(`A price list named "${name}" already exists`);
      throw error;
    }
  }
}
