import { Injectable } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { Prisma, PurchaseOrderStatus } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { purchaseOrderReference } from './purchase-order-status';

type Db = Prisma.TransactionClient;

const WITH_DETAILS = {
  lines: { orderBy: { id: 'asc' } },
  receipts: {
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
    include: { lines: { orderBy: { id: 'asc' }, include: { line: { select: { variantId: true } } } } },
  },
} satisfies Prisma.PurchaseOrderInclude;

type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{ include: typeof WITH_DETAILS }>;

export interface PurchaseOrderLineView {
  id: string;
  variantId: string;
  quantityOrdered: number;
  quantityReceived: number;
  quantityOutstanding: number;
  unitCost: Decimal;
  lineCost: Decimal;
}

export interface ReceiptLineView {
  id: string;
  lineId: string;
  variantId: string;
  quantity: number;
  unitCost: Decimal;
  cost: Decimal;
  lotId: string | null;
  movementId: string;
}

export interface ReceiptView {
  id: string;
  receivedById: string;
  receivedAt: Date;
  note: string | null;
  lines: ReceiptLineView[];
  cost: Decimal;
}

export type PurchaseOrderView = Omit<PurchaseOrderRow, 'lines' | 'receipts'> & {
  reference: string;
  lines: PurchaseOrderLineView[];
  receipts: ReceiptView[];
  totalCost: Decimal;
  receivedCost: Decimal;
};

export interface PurchaseOrderFilter {
  status?: PurchaseOrderStatus;
  supplierId?: string;
  locationId?: string;
  variantId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

const sum = (values: Decimal[]) => values.reduce((total, value) => total.add(value), new Decimal(0));

/** The read model: derived quantities and costs (unit cost × units) next to the stored rows. */
function view(row: PurchaseOrderRow): PurchaseOrderView {
  const lines = row.lines.map((line) => ({
    id: line.id,
    variantId: line.variantId,
    quantityOrdered: line.quantityOrdered,
    quantityReceived: line.quantityReceived,
    quantityOutstanding: line.quantityOrdered - line.quantityReceived,
    unitCost: line.unitCost,
    lineCost: line.unitCost.mul(line.quantityOrdered),
  }));
  const receipts = row.receipts.map((receipt) => {
    const receiptLines = receipt.lines.map((line) => ({
      id: line.id,
      lineId: line.lineId,
      variantId: line.line.variantId,
      quantity: line.quantity,
      unitCost: line.unitCost,
      cost: line.unitCost.mul(line.quantity),
      lotId: line.lotId,
      movementId: line.movementId,
    }));
    return {
      id: receipt.id,
      receivedById: receipt.receivedById,
      receivedAt: receipt.receivedAt,
      note: receipt.note,
      lines: receiptLines,
      cost: sum(receiptLines.map((line) => line.cost)),
    };
  });
  return {
    ...row,
    reference: purchaseOrderReference(row.number),
    lines,
    receipts,
    totalCost: sum(lines.map((line) => line.lineCost)),
    receivedCost: sum(receipts.map((receipt) => receipt.cost)),
  };
}

/** Purchase orders, their lines and receipts; writes run on the caller's transaction. */
@Injectable()
export class PurchaseOrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, db: Db = this.prisma): Promise<PurchaseOrderView | null> {
    const row = await db.purchaseOrder.findUnique({ where: { id }, include: WITH_DETAILS });
    return row && view(row);
  }

  async findByIdOrThrow(db: Db, id: string): Promise<PurchaseOrderView> {
    return view(await db.purchaseOrder.findUniqueOrThrow({ where: { id }, include: WITH_DETAILS }));
  }

  /** Locks the purchase order's row for the rest of the transaction; false when it does not exist. */
  async lock(db: Db, id: string): Promise<boolean> {
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${id} FOR UPDATE`;
    return rows.length === 1;
  }

  async findSupplier(db: Db, id: string): Promise<{ name: string; isActive: boolean } | null> {
    return db.supplier.findUnique({ where: { id }, select: { name: true, isActive: true } });
  }

  async findLocation(db: Db, id: string): Promise<{ name: string; isActive: boolean } | null> {
    return db.stockLocation.findUnique({ where: { id }, select: { name: true, isActive: true } });
  }

  async existingVariantIds(db: Db, ids: string[]): Promise<string[]> {
    return (await db.variant.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((v) => v.id);
  }

  async storeCurrency(db: Db) {
    return (await db.store.findFirstOrThrow({ where: { singleton: true }, select: { currency: true } })).currency;
  }

  async create(
    db: Db,
    data: Omit<Prisma.PurchaseOrderUncheckedCreateInput, 'lines' | 'receipts'> & {
      lines: { variantId: string; quantity: number; unitCost: Decimal }[];
    },
  ): Promise<PurchaseOrderView> {
    const { lines, ...order } = data;
    const row = await db.purchaseOrder.create({
      data: {
        ...order,
        lines: {
          create: lines.map((line) => ({
            variantId: line.variantId,
            quantityOrdered: line.quantity,
            unitCost: line.unitCost,
          })),
        },
      },
      include: WITH_DETAILS,
    });
    return view(row);
  }

  async update(db: Db, id: string, data: Prisma.PurchaseOrderUncheckedUpdateInput): Promise<void> {
    await db.purchaseOrder.update({ where: { id }, data });
  }

  async replaceLines(db: Db, id: string, lines: { variantId: string; quantity: number; unitCost: Decimal }[]) {
    await db.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } });
    await db.purchaseOrderLine.createMany({
      data: lines.map((line) => ({
        purchaseOrderId: id,
        variantId: line.variantId,
        quantityOrdered: line.quantity,
        unitCost: line.unitCost,
      })),
    });
  }

  /** Moves the order from `from` to `to` only if it is still `from`; false when another request got there first. */
  async transition(
    db: Db,
    id: string,
    from: PurchaseOrderStatus,
    to: PurchaseOrderStatus,
    stamp: Prisma.PurchaseOrderUncheckedUpdateManyInput,
  ): Promise<boolean> {
    const { count } = await db.purchaseOrder.updateMany({
      where: { id, status: from },
      data: { ...stamp, status: to },
    });
    return count === 1;
  }

  async createReceipt(db: Db, data: { purchaseOrderId: string; receivedById: string; note?: string }) {
    return db.purchaseOrderReceipt.create({ data, select: { id: true } });
  }

  /** Adds received units to a line, only while they stay within what was ordered; false otherwise. */
  async addReceived(db: Db, lineId: string, quantity: number): Promise<boolean> {
    const count = await db.$executeRaw`
      UPDATE "PurchaseOrderLine" SET "quantityReceived" = "quantityReceived" + ${quantity}
      WHERE "id" = ${lineId} AND "quantityReceived" + ${quantity} <= "quantityOrdered"`;
    return count === 1;
  }

  async createReceiptLine(db: Db, data: Prisma.PurchaseOrderReceiptLineUncheckedCreateInput): Promise<void> {
    await db.purchaseOrderReceiptLine.create({ data });
  }

  /** Purchase orders newest first, a page of `take` after the `after` cursor (a purchase order id). */
  async findMany(
    filter: PurchaseOrderFilter,
    page: { take: number; after?: string },
  ): Promise<[PurchaseOrderView[], number]> {
    const where: Prisma.PurchaseOrderWhereInput = {
      status: filter.status,
      supplierId: filter.supplierId,
      locationId: filter.locationId,
      ...(filter.variantId && { lines: { some: { variantId: filter.variantId } } }),
      ...((filter.createdFrom || filter.createdTo) && {
        createdAt: { gte: filter.createdFrom, lt: filter.createdTo },
      }),
    };
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        include: WITH_DETAILS,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    return [rows.map(view), total];
  }
}
