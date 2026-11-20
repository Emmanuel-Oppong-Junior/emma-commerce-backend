import { OrderStatus } from '../generated/prisma/client';
import { JobQueue } from '../jobs/job-queues';
import { JobMeta } from '../jobs/job-context';

/**
 * Event names are versioned: they are a contract with consumers (ADR-0009). Change a payload by adding a `.v2` type
 * next to the old one, never by editing a published shape.
 */
export interface DomainEventPayloads {
  'order.placed.v1': { orderId: string };
  'order.status_changed.v1': { orderId: string; status: OrderStatus; trackingNumber: string | null };
  'order.shipment_updated.v1': { orderId: string; trackingNumber: string };
  'payment.succeeded.v1': { orderId: string; paymentId: string; amount: string };
  /** Available stock of a variant at a location fell to its low-stock threshold (raised once per crossing). */
  'inventory.low_stock.v1': { variantId: string; locationId: string; available: number; movementId: string };
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
  'payment.succeeded.v1': JobQueue.NOTIFICATIONS,
  'inventory.low_stock.v1': JobQueue.NOTIFICATIONS,
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
