import { Injectable } from '@nestjs/common';
import { DeliveryClosure, DeliverySlot, OrderStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/** A YYYY-MM-DD date as the Date Prisma stores in a DATE column (UTC midnight). */
export const toDbDate = (date: string) => new Date(`${date}T00:00:00Z`);
export const fromDbDate = (date: Date) => date.toISOString().slice(0, 10);

export type SlotData = Pick<
  DeliverySlot,
  'weekday' | 'startMinute' | 'endMinute' | 'capacity' | 'cutoffHours' | 'isActive'
>;

@Injectable()
export class DeliverySlotsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** The zone's slot templates, its closures from `from` on, and the bookings of its slots in [from, to]. */
  async calendar(zoneId: string, from: string, to: string, db: Prisma.TransactionClient = this.prisma) {
    const range = { gte: toDbDate(from), lte: toDbDate(to) };
    // One after the other: `db` may be the order transaction, which runs one query at a time anyway.
    const templates = await db.deliverySlot.findMany({ where: { zoneId } });
    const closures = await db.deliveryClosure.findMany({ where: { zoneId, date: range } });
    const bookings = await db.deliverySlotBooking.findMany({ where: { slot: { zoneId }, date: range } });
    return { templates, closures, bookings };
  }

  /**
   * Takes one place in the slot on the date if fewer than `capacity` are booked: one conditional increment, which
   * waits for a concurrent booking of the same row and re-checks, so the slot is never oversold. False when full.
   */
  async book(tx: Prisma.TransactionClient, slotId: string, date: string, capacity: number): Promise<boolean> {
    await tx.$executeRaw`
      INSERT INTO "DeliverySlotBooking" ("id", "slotId", "date", "booked")
      VALUES (gen_random_uuid()::text, ${slotId}, ${toDbDate(date)}, 0)
      ON CONFLICT ("slotId", "date") DO NOTHING`;
    const { count } = await tx.deliverySlotBooking.updateMany({
      where: { slotId, date: toDbDate(date), booked: { lt: capacity } },
      data: { booked: { increment: 1 } },
    });
    return count === 1;
  }

  /**
   * Gives the order's slot place back, once: the order is marked released with a conditional update first, so a
   * repeated cancel or expiry releases nothing. Returns whether a place was released.
   */
  async releaseForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<boolean> {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, deliverySlotId: { not: null }, deliverySlotReleasedAt: null },
      data: { deliverySlotReleasedAt: new Date() },
    });
    if (count === 0) return false;
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { deliverySlotId: true, deliveryDate: true },
    });
    await tx.deliverySlotBooking.updateMany({
      where: { slotId: order.deliverySlotId!, date: order.deliveryDate!, booked: { gt: 0 } },
      data: { booked: { decrement: 1 } },
    });
    return true;
  }

  /** The zone's slot templates, Monday first, then by start. */
  async slotsOfZone(zoneId: string): Promise<DeliverySlot[]> {
    return this.prisma.deliverySlot.findMany({
      where: { zoneId },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
  }

  async closuresFrom(zoneId: string, from: string): Promise<DeliveryClosure[]> {
    return this.prisma.deliveryClosure.findMany({
      where: { zoneId, date: { gte: toDbDate(from) } },
      orderBy: { date: 'asc' },
    });
  }

  async findSlot(id: string): Promise<DeliverySlot | null> {
    return this.prisma.deliverySlot.findUnique({ where: { id } });
  }

  async createSlot(zoneId: string, data: SlotData, db: Prisma.TransactionClient): Promise<DeliverySlot> {
    return db.deliverySlot.create({ data: { ...data, zoneId } });
  }

  async updateSlot(id: string, data: Partial<SlotData>, db: Prisma.TransactionClient): Promise<DeliverySlot> {
    return db.deliverySlot.update({ where: { id }, data });
  }

  async countBookings(slotId: string): Promise<number> {
    return this.prisma.deliverySlotBooking.count({ where: { slotId } });
  }

  async deleteSlot(id: string, db: Prisma.TransactionClient): Promise<DeliverySlot> {
    return db.deliverySlot.delete({ where: { id } });
  }

  async findClosure(id: string): Promise<DeliveryClosure | null> {
    return this.prisma.deliveryClosure.findUnique({ where: { id } });
  }

  async createClosure(
    zoneId: string,
    data: { date: string; reason: string | null },
    db: Prisma.TransactionClient,
  ): Promise<DeliveryClosure> {
    return db.deliveryClosure.create({ data: { zoneId, date: toDbDate(data.date), reason: data.reason } });
  }

  async deleteClosure(id: string, db: Prisma.TransactionClient): Promise<DeliveryClosure> {
    return db.deliveryClosure.delete({ where: { id } });
  }

  /** The slots booked on a date (optionally in one zone), with the orders holding a place. */
  async bookingsOn(date: string, zoneId?: string) {
    return this.prisma.deliverySlotBooking.findMany({
      where: { date: toDbDate(date), booked: { gt: 0 }, ...(zoneId && { slot: { zoneId } }) },
      include: { slot: { include: { zone: { select: { id: true, name: true } } } } },
      orderBy: [{ slot: { zoneId: 'asc' } }, { slot: { startMinute: 'asc' } }],
    });
  }

  async ordersInSlots(date: string, slotIds: string[]) {
    return this.prisma.order.findMany({
      where: {
        deliverySlotId: { in: slotIds },
        deliveryDate: toDbDate(date),
        deliverySlotReleasedAt: null,
        status: { notIn: [OrderStatus.CANCELLED, OrderStatus.EXPIRED] },
      },
      select: { id: true, orderNumber: true, status: true, deliverySlotId: true },
      orderBy: { orderNumber: 'asc' },
    });
  }
}
