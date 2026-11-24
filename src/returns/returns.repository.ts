import { Injectable } from '@nestjs/common';
import {
  Order,
  Prisma,
  RefundStatus,
  ReturnResolution,
  ReturnStatus,
  ShipmentStatus,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CLOSED_WITHOUT_RETURN } from './return-status';
import { CheckedReturnLine, LineUnits } from './return-rules';

type Db = Prisma.TransactionClient;

const WITH_LINES = {
  lines: {
    include: { orderItem: { select: { productName: true, sku: true, productId: true, variantId: true } } },
    orderBy: { id: 'asc' },
  },
  events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.ReturnRequestInclude;

export type ReturnWithLines = Prisma.ReturnRequestGetPayload<{ include: typeof WITH_LINES }>;

/** An order line with what a return of it is checked against. */
export interface ReturnableOrderLine {
  id: string;
  productId: string;
  variantId: string;
  productName: string;
  unitListPrice: Prisma.Decimal;
  productType: { name: string; returnable: boolean; returnWindowDays: number | null };
  units: LineUnits;
}

export interface ReturnFilter {
  status?: ReturnStatus;
  orderId?: string;
  userId?: string;
  createdFrom?: Date;
  createdTo?: Date;
}

@Injectable()
export class ReturnsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Locks the order row, so returns of one order are checked and written one at a time; null if it does not exist. */
  async lockOrder(tx: Db, orderId: string): Promise<Order | null> {
    await tx.$queryRaw`SELECT 1 FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    return tx.order.findUnique({ where: { id: orderId } });
  }

  async storeWindowDays(db: Db): Promise<number> {
    const store = await db.store.findFirstOrThrow({ where: { singleton: true }, select: { returnWindowDays: true } });
    return store.returnWindowDays;
  }

  /**
   * The order's lines with their product type's return policy, the units of each in DELIVERED shipments (with when),
   * the units refunded outside returns (FAILED refunds excluded) and the units claimed by live returns.
   */
  async returnableLines(db: Db, orderId: string): Promise<ReturnableOrderLine[]> {
    const items = await db.orderItem.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        productId: true,
        variantId: true,
        productName: true,
        unitListPrice: true,
        product: { select: { productType: { select: { name: true, returnable: true, returnWindowDays: true } } } },
        shipmentItems: {
          where: { shipment: { status: ShipmentStatus.DELIVERED } },
          select: { quantity: true, shipment: { select: { deliveredAt: true } } },
        },
        refundLines: {
          where: { refund: { returnRequestId: null, status: { not: RefundStatus.FAILED } } },
          select: { quantity: true },
        },
        returnLines: {
          where: { returnRequest: { status: { notIn: CLOSED_WITHOUT_RETURN } } },
          select: { quantity: true, receivedQuantity: true },
        },
      },
    });
    return items.map((item) => ({
      id: item.id,
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      unitListPrice: item.unitListPrice,
      productType: item.product.productType,
      units: {
        deliveries: item.shipmentItems.map((shipped) => ({
          deliveredAt: shipped.shipment.deliveredAt,
          quantity: shipped.quantity,
        })),
        refundedOutsideReturns: item.refundLines.reduce((sum, line) => sum + line.quantity, 0),
        claimedByReturns: item.returnLines.reduce((sum, line) => sum + (line.receivedQuantity ?? line.quantity), 0),
      },
    }));
  }

  /** Variants offered in exchange, with what decides whether they can be sold. */
  async findVariants(db: Db, ids: string[]) {
    return db.variant.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        productId: true,
        sku: true,
        optionValues: true,
        price: true,
        isActive: true,
        product: { select: { name: true, isActive: true, status: true } },
      },
    });
  }

  /** Writes the request, its lines and its first history event (REQUESTED, then APPROVED when `approved`). */
  async create(
    tx: Db,
    data: {
      orderId: string;
      userId: string;
      resolution: ReturnResolution;
      lines: CheckedReturnLine[];
      actorId: string;
      createdById?: string;
      policyOverrideReason?: string;
      staffNote?: string | null;
      approved?: boolean;
    },
  ): Promise<ReturnWithLines> {
    const events: Prisma.ReturnStatusEventCreateWithoutReturnRequestInput[] = [
      { from: null, to: ReturnStatus.REQUESTED, actorId: data.actorId },
    ];
    if (data.approved) {
      events.push({
        from: ReturnStatus.REQUESTED,
        to: ReturnStatus.APPROVED,
        actorId: data.actorId,
        note: data.policyOverrideReason ?? null,
      });
    }
    const created = await tx.returnRequest.create({
      data: {
        orderId: data.orderId,
        userId: data.userId,
        resolution: data.resolution,
        status: data.approved ? ReturnStatus.APPROVED : ReturnStatus.REQUESTED,
        createdById: data.createdById ?? null,
        policyOverrideReason: data.policyOverrideReason ?? null,
        staffNote: data.staffNote ?? null,
        events: { create: events },
      },
    });
    // One insert per line, in order: the ReturnLine_within_delivered trigger checks each against the ones before.
    for (const line of data.lines) {
      await tx.returnLine.create({ data: { ...line, returnRequestId: created.id } });
    }
    return tx.returnRequest.findUniqueOrThrow({ where: { id: created.id }, include: WITH_LINES });
  }

  async findById(id: string, db: Db = this.prisma): Promise<ReturnWithLines | null> {
    return db.returnRequest.findUnique({ where: { id }, include: WITH_LINES });
  }

  /** Returns newest first, a page of `take` after the `after` cursor (a return request id). */
  async findMany(filter: ReturnFilter, page: { take: number; after?: string }): Promise<[ReturnWithLines[], number]> {
    const where: Prisma.ReturnRequestWhereInput = {
      status: filter.status,
      orderId: filter.orderId,
      userId: filter.userId,
      createdAt: { gte: filter.createdFrom, lt: filter.createdTo },
    };
    return Promise.all([
      this.prisma.returnRequest.findMany({
        where,
        include: WITH_LINES,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.take,
        ...(page.after && { cursor: { id: page.after }, skip: 1 }),
      }),
      this.prisma.returnRequest.count({ where }),
    ]);
  }

  async setReceived(tx: Db, lineId: string, receivedQuantity: number): Promise<void> {
    await tx.returnLine.update({ where: { id: lineId }, data: { receivedQuantity } });
  }

  async setDisposition(tx: Db, lineId: string, restockQuantity: number, writeOffQuantity: number): Promise<void> {
    await tx.returnLine.update({ where: { id: lineId }, data: { restockQuantity, writeOffQuantity } });
  }
}
