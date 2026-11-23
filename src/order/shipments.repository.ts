import { Injectable } from '@nestjs/common';
import { Prisma, RefundStatus, ShipmentStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AllocatedShipment, OrderLineQuantity, ShipmentLine } from './shipment-allocation';
import { ORDER_INCLUDE, ShipmentWithItems } from './order.repository';

type Tx = Prisma.TransactionClient;

/** An order's lines and its shipments with their items: what allocation and completion are decided on. */
export interface OrderAllocation {
  lines: OrderLineQuantity[];
  shipments: (AllocatedShipment & { id: string })[];
}

/** Data access for shipments and their items (P5-B.1); writes run on the caller's transaction. */
@Injectable()
export class ShipmentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  runTransaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(work);
  }

  /** The order a shipment belongs to (never changes), or null for an unknown shipment. */
  async findOrderId(tx: Tx, shipmentId: string): Promise<string | null> {
    const shipment = await tx.shipment.findUnique({ where: { id: shipmentId }, select: { orderId: true } });
    return shipment?.orderId ?? null;
  }

  /** The shipment's rider, read without a lock (callers re-check it under the order lock); null when none or unknown. */
  async findRiderId(shipmentId: string): Promise<string | null> {
    const shipment = await this.prisma.shipment.findUnique({ where: { id: shipmentId }, select: { riderId: true } });
    return shipment?.riderId ?? null;
  }

  async exists(shipmentId: string): Promise<boolean> {
    return (await this.prisma.shipment.count({ where: { id: shipmentId } })) > 0;
  }

  /** The shipment line, with its shipment's order and status, or null for an unknown line. */
  async findItem(tx: Tx, shipmentItemId: string) {
    return tx.shipmentItem.findUnique({
      where: { id: shipmentItemId },
      select: { id: true, shipmentId: true, orderItemId: true, shipment: { select: { orderId: true } } },
    });
  }

  async findShipment(tx: Tx, shipmentId: string): Promise<ShipmentWithItems> {
    return tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: { items: { orderBy: { id: 'asc' } } } });
  }

  async findAllocation(tx: Tx, orderId: string): Promise<OrderAllocation> {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        items: { select: { id: true, quantity: true }, orderBy: { id: 'asc' } },
        shipments: {
          select: { id: true, status: true, items: { select: { orderItemId: true, quantity: true } } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    return { lines: order.items, shipments: order.shipments };
  }

  /** A PENDING shipment with its items and first history event. Call with the order row locked. */
  async create(tx: Tx, orderId: string, lines: ShipmentLine[], actorId: string) {
    return tx.shipment.create({
      data: {
        orderId,
        items: { create: lines.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })) },
        events: { create: { from: null, to: ShipmentStatus.PENDING, actorId } },
      },
      include: ORDER_INCLUDE.shipments.include,
    });
  }

  async findWithHistory(shipmentId: string) {
    return this.prisma.shipment.findUniqueOrThrow({
      where: { id: shipmentId },
      include: ORDER_INCLUDE.shipments.include,
    });
  }

  /** Units of each of the order's lines refunded by a refund that has not failed. */
  async refundedUnits(tx: Tx, orderId: string): Promise<Map<string, number>> {
    const rows = await tx.refundLine.groupBy({
      by: ['orderItemId'],
      where: { orderItem: { orderId }, refund: { status: { not: RefundStatus.FAILED } } },
      _sum: { quantity: true },
    });
    return new Map(rows.map((row) => [row.orderItemId, row._sum.quantity ?? 0]));
  }
}
