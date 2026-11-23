import { Injectable } from '@nestjs/common';
import { Prisma, StockTake, StockTakeLine, StockTakeStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockTakeLineFacts } from './stock-take-variance';

import { UNDISPATCHED_RESERVED_UNITS } from '../awaiting-dispatch';
type Db = Prisma.TransactionClient;

/** What a stock-take counts: a category's variants, a list of variants, or (neither) every variant. */
export interface StockTakeScope {
  categoryId?: string;
  variantIds?: string[];
}

export interface ExpectedStock {
  variantId: string;
  expected: number;
}

export interface StockTakeLineView extends StockTakeLine {
  sku: string;
  productName: string;
}

export interface StockTakeListFilter {
  status?: StockTakeStatus;
  locationId?: string;
}

const LINE_VARIANT = { variant: { select: { sku: true, product: { select: { name: true } } } } } as const;

function lineView({
  variant,
  ...line
}: StockTakeLine & { variant: { sku: string; product: { name: string } } }): StockTakeLineView {
  return { ...line, sku: variant.sku, productName: variant.product.name };
}

/** Data access for stock-takes; writes run on the caller's transaction. */
@Injectable()
export class StockTakeRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The units that should be on the shelf at `locationId` for each variant in scope: on hand plus units already sold
   * (reservation CONSUMED: paid online) whose order has not been dispatched, since those goods are still in the shop.
   * A full or category count covers active variants and archived ones that still have stock there; a list covers
   * exactly the variants given.
   */
  async expectedStock(db: Db, locationId: string, scope: StockTakeScope): Promise<ExpectedStock[]> {
    const inScope = scope.variantIds
      ? Prisma.sql`v."id" = ANY(${scope.variantIds}::text[])`
      : Prisma.sql`(v."isActive" OR COALESCE(sl."onHand", 0) > 0)${
          scope.categoryId ? Prisma.sql` AND p."categoryId" = ${scope.categoryId}` : Prisma.empty
        }`;
    return db.$queryRaw<ExpectedStock[]>`
      WITH awaiting_dispatch AS (
        SELECT r."variantId", sum(${UNDISPATCHED_RESERVED_UNITS})::int AS "quantity"
        FROM "StockReservation" r
        JOIN "Order" o ON o."id" = r."orderId"
        WHERE r."locationId" = ${locationId} AND r."status" = 'CONSUMED'
          AND o."status" IN ('CONFIRMED', 'IN_FULFILMENT')
        GROUP BY r."variantId"
      )
      SELECT v."id" AS "variantId", (COALESCE(sl."onHand", 0) + COALESCE(ad."quantity", 0))::int AS "expected"
      FROM "Variant" v
      JOIN "Product" p ON p."id" = v."productId"
      LEFT JOIN "StockLevel" sl ON sl."variantId" = v."id" AND sl."locationId" = ${locationId}
      LEFT JOIN awaiting_dispatch ad ON ad."variantId" = v."id"
      WHERE ${inScope}
      ORDER BY v."id"`;
  }

  async findOpenAt(db: Db, locationId: string): Promise<{ id: string } | null> {
    return db.stockTake.findFirst({
      where: { locationId, status: { in: [StockTakeStatus.OPEN, StockTakeStatus.SUBMITTED] } },
      select: { id: true },
    });
  }

  async categoryExists(db: Db, id: string): Promise<boolean> {
    return (await db.category.count({ where: { id } })) > 0;
  }

  async existingVariantIds(db: Db, ids: string[]): Promise<string[]> {
    const rows = await db.variant.findMany({ where: { id: { in: ids } }, select: { id: true } });
    return rows.map((row) => row.id);
  }

  async create(
    db: Db,
    data: { locationId: string; categoryId?: string; note?: string; openedById: string },
    lines: ExpectedStock[],
  ): Promise<StockTake> {
    const stockTake = await db.stockTake.create({ data });
    await db.stockTakeLine.createMany({
      data: lines.map((line) => ({
        stockTakeId: stockTake.id,
        variantId: line.variantId,
        expectedAtOpen: line.expected,
      })),
    });
    return stockTake;
  }

  /**
   * The session's status and location with its row locked: FOR SHARE while counting (counts may run side by side but
   * the session cannot be submitted or cancelled until they commit), FOR UPDATE to change its status.
   */
  async lockSession(
    db: Db,
    id: string,
    mode: 'share' | 'update',
  ): Promise<{ status: StockTakeStatus; locationId: string } | null> {
    const lock = mode === 'share' ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR UPDATE`;
    const [row] = await db.$queryRaw<{ status: StockTakeStatus; locationId: string }[]>`
      SELECT "status", "locationId" FROM "StockTake" WHERE "id" = ${id} ${lock}`;
    return row ?? null;
  }

  async findLineVariantIds(db: Db, stockTakeId: string, variantIds: string[]): Promise<string[]> {
    const rows = await db.stockTakeLine.findMany({
      where: { stockTakeId, variantId: { in: variantIds } },
      select: { variantId: true },
    });
    return rows.map((row) => row.variantId);
  }

  async recordCount(
    db: Db,
    stockTakeId: string,
    count: { variantId: string; countedQuantity: number; expectedQuantity: number; variance: number },
    countedById: string,
  ): Promise<void> {
    await db.stockTakeLine.update({
      where: { stockTakeId_variantId: { stockTakeId, variantId: count.variantId } },
      data: {
        countedQuantity: count.countedQuantity,
        expectedQuantity: count.expectedQuantity,
        variance: count.variance,
        countedById,
        countedAt: new Date(),
      },
    });
  }

  /** Moves the session from one of `from` to `to` only if it is still there; false when it is not. */
  async transition(
    db: Db,
    id: string,
    from: StockTakeStatus[],
    to: StockTakeStatus,
    data: Prisma.StockTakeUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await db.stockTake.updateMany({
      where: { id, status: { in: from } },
      data: { ...data, status: to },
    });
    return count === 1;
  }

  async find(db: Db, id: string): Promise<StockTake | null> {
    return db.stockTake.findUnique({ where: { id } });
  }

  async countedLines(db: Db, stockTakeId: string): Promise<{ variantId: string; variance: number | null }[]> {
    return db.stockTakeLine.findMany({
      where: { stockTakeId, countedQuantity: { not: null } },
      select: { variantId: true, variance: true },
    });
  }

  async setLineMovement(db: Db, stockTakeId: string, variantId: string, movementId: string): Promise<void> {
    await db.stockTakeLine.update({
      where: { stockTakeId_variantId: { stockTakeId, variantId } },
      data: { movementId },
    });
  }

  async lineCounts(stockTakeIds: readonly string[]): Promise<Map<string, { lines: number; counted: number }>> {
    const [all, counted] = await Promise.all([
      this.prisma.stockTakeLine.groupBy({
        by: ['stockTakeId'],
        where: { stockTakeId: { in: [...stockTakeIds] } },
        _count: { _all: true },
      }),
      this.prisma.stockTakeLine.groupBy({
        by: ['stockTakeId'],
        where: { stockTakeId: { in: [...stockTakeIds] }, countedQuantity: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const countedById = new Map(counted.map((row) => [row.stockTakeId, row._count._all]));
    return new Map(
      all.map((row) => [row.stockTakeId, { lines: row._count._all, counted: countedById.get(row.stockTakeId) ?? 0 }]),
    );
  }

  /** Sessions newest first, a page of `take` after the `after` cursor (a stock-take id). */
  async list(filter: StockTakeListFilter, page: { take: number; after?: string }): Promise<[StockTake[], number]> {
    const where: Prisma.StockTakeWhereInput = { status: filter.status, locationId: filter.locationId };
    return Promise.all([
      this.prisma.stockTake.findMany({
        where,
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.stockTake.count({ where }),
    ]);
  }

  /** Lines in variant SKU order, a page of `take` after the `after` cursor (a line id). */
  async lines(
    stockTakeId: string,
    filter: { counted?: boolean },
    page: { take: number; after?: string },
  ): Promise<[StockTakeLineView[], number]> {
    const where: Prisma.StockTakeLineWhereInput = {
      stockTakeId,
      ...(filter.counted !== undefined && { countedQuantity: filter.counted ? { not: null } : null }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.stockTakeLine.findMany({
        where,
        include: LINE_VARIANT,
        orderBy: [{ variant: { sku: 'asc' } }, { id: 'asc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.stockTakeLine.count({ where }),
    ]);
    return [rows.map(lineView), total];
  }

  async linesOf(stockTakeId: string, variantIds: string[]): Promise<StockTakeLineView[]> {
    const rows = await this.prisma.stockTakeLine.findMany({
      where: { stockTakeId, variantId: { in: variantIds } },
      include: LINE_VARIANT,
      orderBy: [{ variant: { sku: 'asc' } }, { id: 'asc' }],
    });
    return rows.map(lineView);
  }

  /** Every line with what the variance report needs, in SKU order. */
  async reportLines(stockTakeId: string): Promise<StockTakeLineFacts[]> {
    const rows = await this.prisma.stockTakeLine.findMany({
      where: { stockTakeId },
      select: {
        variantId: true,
        expectedAtOpen: true,
        expectedQuantity: true,
        countedQuantity: true,
        variance: true,
        variant: { select: { sku: true, price: true, costPrice: true, product: { select: { name: true } } } },
      },
      orderBy: { variant: { sku: 'asc' } },
    });
    return rows.map(({ variant, ...line }) => ({
      ...line,
      sku: variant.sku,
      productName: variant.product.name,
      unitPrice: variant.price,
      unitCost: variant.costPrice,
    }));
  }
}
