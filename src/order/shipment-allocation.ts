import { PaymentMethod, ShipmentStatus } from '../generated/prisma/client';
import { isShipmentOpen } from './shipment-status';

/** `extensions.reason` values of the errors shipment creation fails with. */
export const NOTHING_TO_SHIP = 'NOTHING_TO_SHIP';
export const SHIPMENT_QUANTITY_EXCEEDED = 'SHIPMENT_QUANTITY_EXCEEDED';
export const COD_ORDER_NOT_SPLIT = 'COD_ORDER_NOT_SPLIT';

export interface OrderLineQuantity {
  id: string;
  quantity: number;
}

export interface ShipmentLine {
  orderItemId: string;
  quantity: number;
}

export interface AllocatedShipment {
  status: ShipmentStatus;
  items: ShipmentLine[];
}

export type ShipmentPlan =
  { ok: true; lines: ShipmentLine[] } | { ok: false; problem: string; reason?: string; conflict?: boolean };

/** Units of each order line not yet in a shipment; a cancelled shipment gives its units back. */
export function unshippedQuantities(
  lines: readonly OrderLineQuantity[],
  shipments: readonly AllocatedShipment[],
): Map<string, number> {
  const remaining = new Map(lines.map((line) => [line.id, line.quantity]));
  for (const shipment of shipments) {
    if (shipment.status === ShipmentStatus.CANCELLED) continue;
    for (const item of shipment.items) {
      remaining.set(item.orderItemId, (remaining.get(item.orderItemId) ?? 0) - item.quantity);
    }
  }
  return remaining;
}

/**
 * The lines of a new shipment of an order: the requested ones, or every unshipped unit when none are requested. A
 * line may not be named twice, must be on the order and may not take more than its unshipped units (a conflict: the
 * state decides). A cash-on-delivery order is never split: its one shipment carries everything, so the single cash
 * collection (the grand total) matches a single delivery.
 */
export function planShipment(
  paymentMethod: PaymentMethod,
  lines: readonly OrderLineQuantity[],
  shipments: readonly AllocatedShipment[],
  requested?: readonly ShipmentLine[],
): ShipmentPlan {
  const remaining = unshippedQuantities(lines, shipments);
  const planned = requested ?? lines.map((line) => ({ orderItemId: line.id, quantity: remaining.get(line.id)! }));
  const seen = new Set<string>();
  for (const line of requested ?? []) {
    if (seen.has(line.orderItemId)) return { ok: false, problem: `Order line "${line.orderItemId}" is named twice` };
    seen.add(line.orderItemId);
    if (!remaining.has(line.orderItemId)) {
      return { ok: false, problem: `Order line "${line.orderItemId}" is not on this order` };
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      return { ok: false, problem: `Quantity of order line "${line.orderItemId}" must be a whole number above 0` };
    }
    if (line.quantity > remaining.get(line.orderItemId)!) {
      return {
        ok: false,
        conflict: true,
        reason: SHIPMENT_QUANTITY_EXCEEDED,
        problem:
          `Order line "${line.orderItemId}" has ${Math.max(remaining.get(line.orderItemId)!, 0)} unit(s) not yet in ` +
          `a shipment; ${line.quantity} requested`,
      };
    }
  }
  const nonEmpty = planned.filter((line) => line.quantity > 0);
  if (nonEmpty.length === 0) {
    return {
      ok: false,
      conflict: true,
      reason: NOTHING_TO_SHIP,
      problem: 'Every unit of this order is already in a shipment',
    };
  }
  if (paymentMethod === PaymentMethod.CASH_ON_DELIVERY) {
    const everything = lines.every(
      (line) => nonEmpty.find((planned) => planned.orderItemId === line.id)?.quantity === line.quantity,
    );
    if (!everything) {
      return {
        ok: false,
        reason: COD_ORDER_NOT_SPLIT,
        problem:
          'A cash-on-delivery order is not split: its one shipment carries every unit, so the cash collected matches ' +
          'one delivery',
      };
    }
  }
  return { ok: true, lines: nonEmpty };
}

/**
 * Whether an order's goods have all reached the customer, which completes an online order: no shipment is still on its
 * way (or in the shop), at least one was delivered, and every ordered unit is in a DELIVERED shipment or was refunded
 * (staff refund what they will not ship, then cancel its shipment).
 */
export function isOrderDelivered(
  lines: readonly OrderLineQuantity[],
  shipments: readonly AllocatedShipment[],
  refundedUnits: ReadonlyMap<string, number>,
): boolean {
  if (shipments.some((shipment) => isShipmentOpen(shipment.status))) return false;
  const delivered = shipments.filter((shipment) => shipment.status === ShipmentStatus.DELIVERED);
  if (delivered.length === 0) return false;
  const deliveredUnits = new Map<string, number>();
  for (const item of delivered.flatMap((shipment) => shipment.items)) {
    deliveredUnits.set(item.orderItemId, (deliveredUnits.get(item.orderItemId) ?? 0) + item.quantity);
  }
  return lines.every((line) => (deliveredUnits.get(line.id) ?? 0) + (refundedUnits.get(line.id) ?? 0) >= line.quantity);
}
