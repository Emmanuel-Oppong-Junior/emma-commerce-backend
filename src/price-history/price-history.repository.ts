import { Injectable } from '@nestjs/common';
import { PriceChange, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FieldChange, PriceChangeOrigin } from './price-change';

export interface PriceChangeFilter {
  variantId?: string;
  productId?: string;
  from?: Date;
  to?: Date;
}

/**
 * The tail of a bulk reprice statement: inserts a PRICE row for each row of a preceding `repriced` CTE returning
 * ("id", "oldPrice", "newPrice"), in the store currency. A missing store row fails the insert (currency is NOT NULL).
 */
export function insertRepricedChanges(origin: PriceChangeOrigin): Prisma.Sql {
  return Prisma.sql`
    INSERT INTO "PriceChange" ("id", "variantId", "field", "oldValue", "newValue", "currency", "source", "reason", "actorId")
    SELECT 'price_change_' || gen_random_uuid(), r."id", 'PRICE', r."oldPrice", r."newPrice",
           (SELECT s."currency" FROM "Store" s WHERE s."singleton"),
           ${origin.source}::"PriceChangeSource", ${origin.reason}::text, ${origin.actorId}::text
    FROM repriced r
  `;
}

@Injectable()
export class PriceHistoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Appends one row per change (at least one) of the variant, in the store currency, on the caller's transaction. */
  async append(
    tx: Prisma.TransactionClient,
    variantId: string,
    changes: FieldChange[],
    origin: PriceChangeOrigin,
  ): Promise<void> {
    const { currency } = await tx.store.findUniqueOrThrow({ where: { singleton: true }, select: { currency: true } });
    await tx.priceChange.createMany({
      data: changes.map((change) => ({ variantId, ...change, currency, ...origin })),
    });
  }

  async findPage(filter: PriceChangeFilter, page: { take: number; after?: string }): Promise<[PriceChange[], number]> {
    const where: Prisma.PriceChangeWhereInput = {
      variantId: filter.variantId,
      ...(filter.productId && { variant: { productId: filter.productId } }),
      ...((filter.from || filter.to) && { createdAt: { gte: filter.from, lt: filter.to } }),
    };
    return Promise.all([
      this.prisma.priceChange.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.priceChange.count({ where }),
    ]);
  }
}
