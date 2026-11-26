import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DeliveryClosure, DeliverySlot, Prisma } from '../../generated/prisma/client';
import { AuditService, fieldChanges, fieldValues } from '../../commons/audit.service';
import {
  AvailableSlot,
  bookingKey,
  formatMinutes,
  parseTime,
  SLOT_DAYS,
  SLOT_FULL,
  SlotCalendar,
  slotTemplateProblem,
  weekdayOf,
} from './delivery-slots';
import { DeliverySlotsRepository, fromDbDate, SlotData } from './delivery-slots.repository';
import {
  AvailableDeliverySlot,
  CreateDeliverySlotInput,
  DeliveryBooking,
  DeliveryClosureEntity,
  DeliveryClosureInput,
  DeliverySlotEntity,
  DeliveryWindow,
  UpdateDeliverySlotInput,
} from './delivery-slots.types';

const AUDITED_SLOT_FIELDS = [
  'zoneId',
  'weekday',
  'startMinute',
  'endMinute',
  'capacity',
  'cutoffHours',
  'isActive',
] as const satisfies readonly (keyof DeliverySlot)[];

const DAY_MS = 24 * 60 * 60 * 1000;

export function slotFull(): ConflictException {
  return new ConflictException({
    message: 'That delivery slot has just been fully booked: choose another one',
    extensions: { reason: SLOT_FULL },
  });
}

export const toSlotEntity = (slot: DeliverySlot): DeliverySlotEntity => ({
  id: slot.id,
  zoneId: slot.zoneId,
  weekday: slot.weekday,
  startTime: formatMinutes(slot.startMinute),
  endTime: formatMinutes(slot.endMinute),
  capacity: slot.capacity,
  cutoffHours: slot.cutoffHours,
  isActive: slot.isActive,
});

export const toWindow = (
  slot: Pick<AvailableSlot, 'slotId' | 'date' | 'startMinute' | 'endMinute'>,
): DeliveryWindow => ({
  slotId: slot.slotId,
  date: slot.date,
  startTime: formatMinutes(slot.startMinute),
  endTime: formatMinutes(slot.endMinute),
});

export const toAvailableDeliverySlot = (slot: AvailableSlot): AvailableDeliverySlot => ({
  ...toWindow(slot),
  remaining: slot.remaining,
});

const toClosureEntity = (closure: DeliveryClosure): DeliveryClosureEntity => ({
  id: closure.id,
  zoneId: closure.zoneId,
  date: fromDbDate(closure.date),
  reason: closure.reason,
});

function minutesOf(value: string, field: string): number {
  const minutes = parseTime(value);
  if (minutes === null) throw new BadRequestException(`${field} must be a time of day as HH:MM (00:00-24:00)`);
  return minutes;
}

/**
 * Delivery slots (P5-A.2): weekly windows per zone with a capacity, per-date closures, and the bookings checkout
 * takes and cancel/expiry give back. Times are Africa/Accra, which is UTC all year (no daylight saving).
 */
@Injectable()
export class DeliverySlotsService {
  constructor(
    private readonly repository: DeliverySlotsRepository,
    private readonly auditService: AuditService,
  ) {}

  /** The zone's slots, closures and bookings for the days checkout offers, from `now`'s date. */
  async calendar(zoneId: string, now: Date, db?: Prisma.TransactionClient): Promise<SlotCalendar> {
    const from = now.toISOString().slice(0, 10);
    const to = new Date(now.getTime() + SLOT_DAYS * DAY_MS).toISOString().slice(0, 10);
    const { templates, closures, bookings } = await this.repository.calendar(zoneId, from, to, db);
    return {
      templates,
      closedDates: new Set(closures.map((closure) => fromDbDate(closure.date))),
      booked: new Map(
        bookings.map((booking) => [bookingKey(booking.slotId, fromDbDate(booking.date)), booking.booked]),
      ),
    };
  }

  /** Books a place in the slot on the order's transaction; CONFLICT with reason SLOT_FULL when none is left. */
  async book(tx: Prisma.TransactionClient, slot: Pick<AvailableSlot, 'slotId' | 'date' | 'capacity'>): Promise<void> {
    if (!(await this.repository.book(tx, slot.slotId, slot.date, slot.capacity))) throw slotFull();
  }

  /** Gives a cancelled or expired order's slot place back, once. */
  async releaseForOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await this.repository.releaseForOrder(tx, orderId);
  }

  async zoneSlots(zoneId: string): Promise<DeliverySlotEntity[]> {
    return (await this.repository.slotsOfZone(zoneId)).map(toSlotEntity);
  }

  /** The zone's closures from today on. */
  async zoneClosures(zoneId: string, now = new Date()): Promise<DeliveryClosureEntity[]> {
    return (await this.repository.closuresFrom(zoneId, now.toISOString().slice(0, 10))).map(toClosureEntity);
  }

  async createSlot(zoneId: string, input: CreateDeliverySlotInput, actorId: string): Promise<DeliverySlotEntity> {
    const data: SlotData = {
      weekday: input.weekday,
      startMinute: minutesOf(input.startTime, 'startTime'),
      endMinute: minutesOf(input.endTime, 'endTime'),
      capacity: input.capacity,
      cutoffHours: input.cutoffHours ?? 0,
      isActive: input.isActive ?? true,
    };
    this.assertValid(data);
    const slot = await this.auditService.record(
      (tx) => this.repository.createSlot(zoneId, data, tx),
      (created) => ({
        entity: 'DeliverySlot',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: fieldValues(created, AUDITED_SLOT_FIELDS) },
      }),
    );
    return toSlotEntity(slot);
  }

  async updateSlot(id: string, input: UpdateDeliverySlotInput, actorId: string): Promise<DeliverySlotEntity> {
    const existing = await this.findSlot(id);
    const data: Partial<SlotData> = {
      startMinute: input.startTime === undefined ? undefined : minutesOf(input.startTime, 'startTime'),
      endMinute: input.endTime === undefined ? undefined : minutesOf(input.endTime, 'endTime'),
      capacity: input.capacity,
      cutoffHours: input.cutoffHours,
      isActive: input.isActive,
    };
    this.assertValid({
      startMinute: data.startMinute ?? existing.startMinute,
      endMinute: data.endMinute ?? existing.endMinute,
      capacity: data.capacity ?? existing.capacity,
      cutoffHours: data.cutoffHours ?? existing.cutoffHours,
    });
    const slot = await this.auditService.record(
      (tx) => this.repository.updateSlot(id, data, tx),
      (updated) => ({
        entity: 'DeliverySlot',
        entityId: id,
        action: 'UPDATE',
        userId: actorId,
        details: { changes: fieldChanges(existing, updated, AUDITED_SLOT_FIELDS) },
      }),
    );
    return toSlotEntity(slot);
  }

  /** Deletes a slot never booked; a booked one can only be deactivated (its bookings are history). */
  async deleteSlot(id: string, actorId: string): Promise<DeliverySlotEntity> {
    await this.findSlot(id);
    if ((await this.repository.countBookings(id)) > 0) {
      throw new ConflictException(`Delivery slot "${id}" has bookings; deactivate it instead`);
    }
    const slot = await this.auditService.record(
      (tx) => this.repository.deleteSlot(id, tx),
      (deleted) => ({
        entity: 'DeliverySlot',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: fieldValues(deleted, AUDITED_SLOT_FIELDS) },
      }),
    );
    return toSlotEntity(slot);
  }

  async addClosure(zoneId: string, input: DeliveryClosureInput, actorId: string): Promise<DeliveryClosureEntity> {
    if (!weekdayOf(input.date)) throw new BadRequestException(`"${input.date}" is not a date`);
    const closure = await this.auditService.record(
      (tx) => this.repository.createClosure(zoneId, { date: input.date, reason: input.reason ?? null }, tx),
      (created) => ({
        entity: 'DeliveryClosure',
        entityId: created.id,
        action: 'CREATE',
        userId: actorId,
        details: { after: { zoneId, date: input.date, reason: input.reason ?? null } },
      }),
    );
    return toClosureEntity(closure);
  }

  async removeClosure(id: string, actorId: string): Promise<DeliveryClosureEntity> {
    if (!(await this.repository.findClosure(id))) throw new NotFoundException(`Delivery closure "${id}" not found`);
    const closure = await this.auditService.record(
      (tx) => this.repository.deleteClosure(id, tx),
      (deleted) => ({
        entity: 'DeliveryClosure',
        entityId: id,
        action: 'DELETE',
        userId: actorId,
        details: { before: { zoneId: deleted.zoneId, date: fromDbDate(deleted.date), reason: deleted.reason } },
      }),
    );
    return toClosureEntity(closure);
  }

  /** The slots booked on a date, with the orders holding their places (staff, for dispatch planning). */
  async bookingsOn(date: string, zoneId?: string): Promise<DeliveryBooking[]> {
    if (!weekdayOf(date)) throw new BadRequestException(`"${date}" is not a date`);
    const bookings = await this.repository.bookingsOn(date, zoneId);
    const orders = await this.repository.ordersInSlots(
      date,
      bookings.map((booking) => booking.slotId),
    );
    return bookings.map((booking) => ({
      ...toWindow({
        slotId: booking.slotId,
        date,
        startMinute: booking.slot.startMinute,
        endMinute: booking.slot.endMinute,
      }),
      zoneId: booking.slot.zone.id,
      zoneName: booking.slot.zone.name,
      capacity: booking.slot.capacity,
      booked: booking.booked,
      orders: orders
        .filter((order) => order.deliverySlotId === booking.slotId)
        .map((order) => ({ orderId: order.id, orderNumber: order.orderNumber, status: order.status })),
    }));
  }

  private async findSlot(id: string): Promise<DeliverySlot> {
    const slot = await this.repository.findSlot(id);
    if (!slot) throw new NotFoundException(`Delivery slot "${id}" not found`);
    return slot;
  }

  private assertValid(slot: Pick<SlotData, 'startMinute' | 'endMinute' | 'capacity' | 'cutoffHours'>): void {
    const problem = slotTemplateProblem(slot);
    if (problem) throw new BadRequestException(problem);
  }
}
