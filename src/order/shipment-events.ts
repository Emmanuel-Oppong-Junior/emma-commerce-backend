import { ShipmentStatus } from '../generated/prisma/client';
import { DomainEvent } from '../outbox/domain-events';
import { isDispatch } from './shipment-status';

interface ShipmentForEvent {
  id: string;
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  items: { orderItemId: string; quantity: number }[];
}

/** The shipment milestones `shipment.status_changed.v1` is recorded for: dispatch and delivery. */
export function isShipmentMilestone(status: ShipmentStatus): boolean {
  return isDispatch(status) || status === ShipmentStatus.DELIVERED;
}

export function shipmentStatusChanged(
  orderId: string,
  shipment: ShipmentForEvent,
): DomainEvent<'shipment.status_changed.v1'> {
  return {
    type: 'shipment.status_changed.v1',
    aggregateId: orderId,
    payload: {
      orderId,
      shipmentId: shipment.id,
      status: shipment.status,
      trackingNumber: shipment.trackingNumber,
      carrier: shipment.carrier,
      items: shipment.items.map(({ orderItemId, quantity }) => ({ orderItemId, quantity })),
    },
  };
}
