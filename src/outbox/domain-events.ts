import { DisputeSource, OrderStatus, ReturnStatus, ShipmentStatus } from '../generated/prisma/client';
import { JobQueue } from '../jobs/job-queues';
import { JobMeta } from '../jobs/job-context';

/**
 * Event names are versioned: they are a contract with consumers (ADR-0009). Change a payload by adding a `.v2` type
 * next to the old one, never by editing a published shape.
 */
export interface DomainEventPayloads {
  'order.placed.v1': { orderId: string };
  /** No longer recorded (P1-O.2); consumed until the queue has drained. `status` uses the old status names. */
  'order.status_changed.v1': { orderId: string; status: string; trackingNumber: string | null };
  /** No longer recorded (P1-O.2, see shipment.tracking_updated.v1); consumed until the queue has drained. */
  'order.shipment_updated.v1': { orderId: string; trackingNumber: string };
  /** An order moved through the order machine (recorded for the statuses the customer is emailed about). */
  'order.status_changed.v2': { orderId: string; from: OrderStatus; to: OrderStatus };
  /**
   * A shipment was dispatched or delivered; the customer is emailed about dispatch. `carrier` and `items` were added
   * in P5-B.1 (absent on events recorded before).
   */
  'shipment.status_changed.v1': {
    orderId: string;
    shipmentId: string;
    status: ShipmentStatus;
    trackingNumber: string | null;
    carrier?: string | null;
    items?: { orderItemId: string; quantity: number }[];
  };
  'shipment.tracking_updated.v1': { orderId: string; shipmentId: string; trackingNumber: string };
  'payment.succeeded.v1': { orderId: string; paymentId: string; amount: string };
  /** A refund moved money back (the provider accepted it, or staff handed cash back); the customer is emailed. */
  'refund.succeeded.v1': { orderId: string; refundId: string };
  /** A chargeback or dispute was opened on a payment (from the provider webhook or by staff). */
  'payment.dispute_opened.v1': { disputeId: string; paymentId: string; orderId: string; source: DisputeSource };
  /** A rider's cash remittance did not match its collections (P3-B.3); the worker logs the ids. */
  'cod.remittance_discrepancy.v1': { remittanceId: string; riderId: string; kind: 'SHORT' | 'OVER' };
  /** Available stock of a variant at a location fell to its low-stock threshold (raised once per crossing). */
  'inventory.low_stock.v1': { variantId: string; locationId: string; available: number; movementId: string };
  /** One staff member's copy of a low-stock digest (P4-B.2); the email lists the digest's alerts. */
  'inventory.low_stock_digest.v1': { digestId: string; recipientId: string };
  /**
   * A return moved to a status the customer is told about (P6-R.1: APPROVED, REJECTED, RECEIVED, EXCHANGED; a refund
   * is told by refund.succeeded.v1). The worker logs the ids until the customer email moves onto the template registry.
   */
  'return.status_changed.v1': { returnRequestId: string; orderId: string; status: ReturnStatus };
  /** An abandoned-cart reminder was recorded (P6-G.2); the worker sends it (email, SMS) if consent still holds. */
  'cart.abandoned_reminder.v1': { reminderId: string; userId: string };
}

export type DomainEventType = keyof DomainEventPayloads;

export interface DomainEvent<T extends DomainEventType = DomainEventType> {
  type: T;
  aggregateId: string;
  payload: DomainEventPayloads[T];
}

/** The queue the relay publishes each event type to; the job is named after the event type. */
export const DOMAIN_EVENT_QUEUES: Record<DomainEventType, JobQueue> = {
  'order.placed.v1': JobQueue.NOTIFICATIONS,
  'order.status_changed.v1': JobQueue.NOTIFICATIONS,
  'order.shipment_updated.v1': JobQueue.NOTIFICATIONS,
  'order.status_changed.v2': JobQueue.NOTIFICATIONS,
  'shipment.status_changed.v1': JobQueue.NOTIFICATIONS,
  'shipment.tracking_updated.v1': JobQueue.NOTIFICATIONS,
  'payment.succeeded.v1': JobQueue.NOTIFICATIONS,
  'refund.succeeded.v1': JobQueue.NOTIFICATIONS,
  'payment.dispute_opened.v1': JobQueue.NOTIFICATIONS,
  'cod.remittance_discrepancy.v1': JobQueue.NOTIFICATIONS,
  'inventory.low_stock.v1': JobQueue.NOTIFICATIONS,
  'inventory.low_stock_digest.v1': JobQueue.NOTIFICATIONS,
  'return.status_changed.v1': JobQueue.NOTIFICATIONS,
  'cart.abandoned_reminder.v1': JobQueue.NOTIFICATIONS,
};

export function isDomainEventType(type: string): type is DomainEventType {
  return Object.prototype.hasOwnProperty.call(DOMAIN_EVENT_QUEUES, type);
}

/** Data of the job published for an outbox row. The job id is the event id, which consumers key idempotency on. */
export interface DomainEventJobData<T extends DomainEventType = DomainEventType> {
  eventId: string;
  aggregateId: string;
  payload: DomainEventPayloads[T];
  /** The request that recorded the event, for log correlation; absent for events recorded outside a request. */
  meta?: JobMeta;
}
