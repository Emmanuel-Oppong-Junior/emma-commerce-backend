import { FulfillmentType, ShipmentStatus } from '../generated/prisma/client';

const S = ShipmentStatus;

/**
 * The fulfilment machine of one shipment (ADR-0014). Steps before dispatch may be skipped forward (a small shop may
 * pack without a separate picking step); a failed delivery can be retried or returned.
 */
const TRANSITIONS: Record<ShipmentStatus, ShipmentStatus[]> = {
  PENDING: [S.PICKING, S.PACKED, S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY],
  PICKING: [S.PACKED, S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY],
  PACKED: [S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY],
  READY_FOR_PICKUP: [S.DELIVERED, S.FAILED_DELIVERY],
  OUT_FOR_DELIVERY: [S.DELIVERED, S.FAILED_DELIVERY],
  FAILED_DELIVERY: [S.OUT_FOR_DELIVERY, S.READY_FOR_PICKUP, S.RETURNED],
  DELIVERED: [],
  RETURNED: [],
};

/** The goods have left the shop: handed to the rider or waiting at the pickup counter. */
export const DISPATCHED_STATUSES: ShipmentStatus[] = [S.READY_FOR_PICKUP, S.OUT_FOR_DELIVERY];

/** The goods are still in the shop (or came back), so the order can still be cancelled. */
export const CANCELLABLE_SHIPMENT_STATUSES: ShipmentStatus[] = [S.PENDING, S.PICKING, S.PACKED, S.RETURNED];

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
