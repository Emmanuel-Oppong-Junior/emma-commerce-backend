import { FulfillmentType, ShipmentStatus } from '../generated/prisma/client';

const S = ShipmentStatus;

/**
 * The fulfilment machine of one shipment (ADR-0014). Steps before dispatch may be skipped forward (a small shop may
 * pack without a separate picking step); a failed delivery can be retried or returned. A shipment is cancelled only
 * before dispatch (P5-B.1), which gives its items back to the order's unshipped units.
 */
const TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  PENDING: [S.PICKING, S.PACKED, S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY, S.CANCELLED],
  PICKING: [S.PACKED, S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY, S.CANCELLED],
  PACKED: [S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY, S.CANCELLED],
  READY_FOR_PICKUP: [S.DELIVERED, S.FAILED_DELIVERY],
  OUT_FOR_DELIVERY: [S.DELIVERED, S.FAILED_DELIVERY],
  FAILED_DELIVERY: [S.OUT_FOR_DELIVERY, S.READY_FOR_PICKUP, S.RETURNED],
  DELIVERED: [],
  RETURNED: [],
  CANCELLED: [],
};

/** The goods have left the shop: handed to the rider or waiting at the pickup counter. */
export const DISPATCHED_STATUSES: ShipmentStatus[] = [S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY];

/** The goods are still in the shop (or came back, or were never sent), so the order can still be cancelled. */
export const CANCELLABLE_SHIPMENT_STATUSES: ShipmentStatus[] = [
  S.PENDING,
  S.PICKING,
  S.PACKED,
  S.RETURNED,
  S.CANCELLED,
];

/** Not yet dispatched: what cancelling the order (or the shipment) cancels. */
export const PRE_DISPATCH_STATUSES: ShipmentStatus[] = [S.PENDING, S.PICKING, S.PACKED];

/** Final: delivered, returned to the shop after failed deliveries, or cancelled before dispatch. */
const FINAL_STATUSES: ShipmentStatus[] = [S.DELIVERED, S.RETURNED, S.CANCELLED];

/** Pickup orders are handed over at the counter, delivery orders go out with a rider. */
function dispatchFor(fulfillmentType: FulfillmentType): ShipmentStatus {
  return fulfillmentType === FulfillmentType.PICKUP ? S.READY_FOR_PICKUP : S.OUT_FOR_DELIVERY;
}

export function canShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
  fulfillmentType: FulfillmentType,
): boolean {
  if (DISPATCHED_STATUSES.includes(to) && to !== dispatchFor(fulfillmentType)) return false;
  return TRANSITIONS[from].includes(to);
}

export function isDispatch(status: ShipmentStatus): boolean {
  return DISPATCHED_STATUSES.includes(status);
}

/** Still in the shop or on its way: not delivered, returned or cancelled. */
export function isShipmentOpen(status: ShipmentStatus): boolean {
  return !FINAL_STATUSES.includes(status);
}
