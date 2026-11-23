import { OrderStatus, ShipmentStatus } from '../generated/prisma/client';

interface StatusChange<S> {
  id: string;
  to: S;
  createdAt: Date;
}

export interface ShipmentHistory {
  id: string;
  carrier: string | null;
  trackingNumber: string | null;
  events: StatusChange<ShipmentStatus>[];
}

/** One step of the customer's tracking timeline: an order status, or a status of one of its shipments. */
export interface TrackingStep {
  at: Date;
  orderStatus: OrderStatus | null;
  shipmentId: string | null;
  shipmentStatus: ShipmentStatus | null;
  carrier: string | null;
  trackingNumber: string | null;
}

/**
 * The customer's tracking timeline (P5-B.2): every order status change and every shipment status change, oldest first
 * (ties: order steps before shipment steps, then by id, so the order is stable between polls). Shipment steps carry the
 * shipment's carrier and tracking number. Only statuses and times: who acted and staff reasons stay out.
 */
export function trackingTimeline(
  orderEvents: readonly StatusChange<OrderStatus>[],
  shipments: readonly ShipmentHistory[],
): TrackingStep[] {
  const keyed: { step: TrackingStep; rank: number; id: string }[] = [
    ...orderEvents.map((event) => ({
      step: {
        at: event.createdAt,
        orderStatus: event.to,
        shipmentId: null,
        shipmentStatus: null,
        carrier: null,
        trackingNumber: null,
      },
      rank: 0,
      id: event.id,
    })),
    ...shipments.flatMap((shipment) =>
      shipment.events.map((event) => ({
        step: {
          at: event.createdAt,
          orderStatus: null,
          shipmentId: shipment.id,
          shipmentStatus: event.to,
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
        },
        rank: 1,
        id: event.id,
      })),
    ),
  ];
  keyed.sort(
    (a, b) => a.step.at.getTime() - b.step.at.getTime() || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return keyed.map(({ step }) => step);
}
