import { Injectable } from '@nestjs/common';
import { PriceChange as PriceChangeRow, Prisma } from '../generated/prisma/client';
import { Money } from '../commons/money/money';
import { PriceChange, PriceChangePage } from './entities/price-change.entity';
import { PriceChangeFilter, PriceHistoryRepository } from './price-history.repository';
import { PriceChangeOrigin, priceFieldChanges, VariantPrices } from './price-change';

function toEntity(row: PriceChangeRow): PriceChange {
  return {
    id: row.id,
    variantId: row.variantId,
    field: row.field,
    oldValue: row.oldValue && Money.of(row.oldValue, row.currency),
    newValue: Money.of(row.newValue, row.currency),
    source: row.source,
    reason: row.reason,
    actorId: row.actorId,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PriceHistoryService {
  constructor(private readonly repository: PriceHistoryRepository) {}

  /**
   * Records the variant's price fields that differ between `before` (null for a new variant) and `after`, on the
   * transaction that wrote them; nothing when no price changed.
   */
  async recordVariantPrices(
    tx: Prisma.TransactionClient,
    variantId: string,
    before: VariantPrices | null,
    after: VariantPrices,
    origin: PriceChangeOrigin,
  ): Promise<void> {
    const changes = priceFieldChanges(before, after);
    if (changes.length > 0) await this.repository.append(tx, variantId, changes, origin);
  }

  async getChanges(filter: PriceChangeFilter, first: number, after?: string): Promise<PriceChangePage> {
    const [rows, totalCount] = await this.repository.findPage(filter, { take: first + 1, after });
    return { nodes: rows.slice(0, first).map(toEntity), totalCount, hasNextPage: rows.length > first };
  }
}
