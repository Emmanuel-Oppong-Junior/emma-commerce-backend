import { Injectable } from '@nestjs/common';
import { Prisma, StockTransfer, StockTransferLine, StockTransferStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type Db = Prisma.TransactionClient;

export type TransferWithLines = StockTransfer & { lines: StockTransferLine[] };

export interface TransferFilter {
  status?: StockTransferStatus;
  locationId?: string;
  variantId?: string;
}

const WITH_LINES = { lines: { orderBy: { id: 'asc' } } } satisfies Prisma.StockTransferInclude;

/** Stock transfers and their lines; writes run on the caller's transaction. */
@Injectable()
export class StockTransfersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, db: Db = this.prisma): Promise<TransferWithLines | null> {
    return db.stockTransfer.findUnique({ where: { id }, include: WITH_LINES });
  }

  async findByIdOrThrow(db: Db, id: string): Promise<TransferWithLines> {
    return db.stockTransfer.findUniqueOrThrow({ where: { id }, include: WITH_LINES });
  }

  async findLocation(db: Db, id: string): Promise<{ name: string; isActive: boolean } | null> {
    return db.stockLocation.findUnique({ where: { id }, select: { name: true, isActive: true } });
  }

  async existingVariantIds(db: Db, ids: string[]): Promise<string[]> {
    return (await db.variant.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((v) => v.id);
  }

  async create(
    db: Db,
    data: {
      fromLocationId: string;
      toLocationId: string;
      note?: string;
      createdById: string;
      lines: { variantId: string; quantity: number }[];
    },
  ): Promise<TransferWithLines> {
    return db.stockTransfer.create({
      data: {
        fromLocationId: data.fromLocationId,
        toLocationId: data.toLocationId,
        note: data.note,
        createdById: data.createdById,
        lines: { create: data.lines.map((line) => ({ variantId: line.variantId, quantity: line.quantity })) },
      },
      include: WITH_LINES,
    });
  }

  /** Moves the transfer from `from` to `to` only if it is still `from`; false when another request got there first. */
  async transition(
    db: Db,
    id: string,
    from: StockTransferStatus,
    to: StockTransferStatus,
    stamp: Prisma.StockTransferUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await db.stockTransfer.updateMany({
      where: { id, status: from },
      data: { ...stamp, status: to },
    });
    return count === 1;
  }

  async recordReceipt(
    db: Db,
    transferId: string,
    line: { variantId: string; receivedQuantity: number; varianceNote: string | null },
  ): Promise<void> {
    await db.stockTransferLine.update({
      where: { transferId_variantId: { transferId, variantId: line.variantId } },
      data: { receivedQuantity: line.receivedQuantity, varianceNote: line.varianceNote },
    });
  }

  /** Transfers newest first, a page of `take` after the `after` cursor (a transfer id). */
  async findMany(
    filter: TransferFilter,
    page: { take: number; after?: string },
  ): Promise<[TransferWithLines[], number]> {
    const where: Prisma.StockTransferWhereInput = {
      status: filter.status,
      ...(filter.locationId && { OR: [{ fromLocationId: filter.locationId }, { toLocationId: filter.locationId }] }),
      ...(filter.variantId && { lines: { some: { variantId: filter.variantId } } }),
    };
    return Promise.all([
      this.prisma.stockTransfer.findMany({
        where,
        include: WITH_LINES,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);
  }

  /** Units on DISPATCHED transfers per variant, optionally of the given variants. */
  async inTransit(variantIds?: string[]): Promise<{ variantId: string; quantity: number }[]> {
    const groups = await this.prisma.stockTransferLine.groupBy({
      by: ['variantId'],
      where: {
        transfer: { status: StockTransferStatus.DISPATCHED },
        ...(variantIds && { variantId: { in: variantIds } }),
      },
      _sum: { quantity: true },
      orderBy: { variantId: 'asc' },
    });
    return groups.map((group) => ({ variantId: group.variantId, quantity: group._sum.quantity ?? 0 }));
  }
}
