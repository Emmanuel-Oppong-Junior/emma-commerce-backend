import { BadRequestException } from '@nestjs/common';
import { Decimal } from '@prisma/client/runtime/client';
import { PaymentIntentStatus, PaymentMethod, Prisma, ShipmentStatus } from '../generated/prisma/client';
import { PAID_INTENT_STATUSES } from '../payment/payment-intent-status';
import { RiderDelivery, RiderDeliveryAddress } from './entities/rider-delivery.entity';

/** What a rider's view of a shipment is read with: the delivery facts only, nothing about costs or other orders. */
export const RIDER_DELIVERY_SELECT = {
  id: true,
  status: true,
  assignedAt: true,
  dispatchedAt: true,
  deliveredAt: true,
  order: {
    select: {
      orderNumber: true,
      paymentMethod: true,
      grandTotal: true,
      contactPhone: true,
      shippingAddressSnapshot: true,
      paymentIntent: { select: { status: true } },
    },
  },
  items: {
    select: { quantity: true, orderItem: { select: { productName: true, sku: true } } },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.ShipmentSelect;

export type RiderDeliveryRow = Prisma.ShipmentGetPayload<{ select: typeof RIDER_DELIVERY_SELECT }>;

/** The open statuses a rider's list shows when no status is asked for: everything not delivered, returned or cancelled. */
export const OPEN_DELIVERY_STATUSES: ShipmentStatus[] = [
  ShipmentStatus.PENDING,
  ShipmentStatus.PICKING,
  ShipmentStatus.PACKED,
  ShipmentStatus.OUT_FOR_DELIVERY,
  ShipmentStatus.FAILED_DELIVERY,
];

/** The UTC day [from, to) of a YYYY-MM-DD date (Ghana keeps UTC all year); BAD_REQUEST for a day that does not exist. */
export function dayRange(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== date) {
    throw new BadRequestException(`date "${date}" is not a calendar day`);
  }
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

function text(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function coordinate(snapshot: Record<string, unknown>, key: string): number | null {
  const value = snapshot[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Cash on delivery not yet paid: the rider collects the order total. */
export function amountToCollect(
  paymentMethod: PaymentMethod,
  grandTotal: Decimal,
  intentStatus: PaymentIntentStatus | null,
): Decimal | null {
  if (paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) return null;
  if (intentStatus && PAID_INTENT_STATUSES.includes(intentStatus)) return null;
  return grandTotal;
}

export function toRiderDelivery(row: RiderDeliveryRow): RiderDelivery {
  const { order } = row;
  const snapshot = (order.shippingAddressSnapshot ?? {}) as Record<string, unknown>;
  const address: RiderDeliveryAddress | null = order.shippingAddressSnapshot
    ? {
        street: text(snapshot, 'street'),
        area: text(snapshot, 'area'),
        city: text(snapshot, 'city'),
        region: text(snapshot, 'region'),
        landmark: text(snapshot, 'landmark'),
        ghanaPostGps: text(snapshot, 'ghanaPostGps'),
        latitude: coordinate(snapshot, 'latitude'),
        longitude: coordinate(snapshot, 'longitude'),
      }
    : null;
  return {
    shipmentId: row.id,
    status: row.status,
    orderNumber: order.orderNumber,
    recipientName: text(snapshot, 'recipientName'),
    recipientPhone: text(snapshot, 'phone') ?? order.contactPhone,
    address,
    items: row.items.map(({ quantity, orderItem }) => ({
      productName: orderItem.productName,
      sku: orderItem.sku,
      quantity,
    })),
    amountToCollect: amountToCollect(order.paymentMethod, order.grandTotal, order.paymentIntent?.status ?? null),
    // Only assigned shipments are read for a rider, and the database ties assignedAt to riderId.
    assignedAt: row.assignedAt!,
    dispatchedAt: row.dispatchedAt,
    deliveredAt: row.deliveredAt,
  };
}
