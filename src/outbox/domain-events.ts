import { OrderStatus } from '../generated/prisma/client';
import { JobQueue } from '../jobs/job-queues';

/**
 * Event names are versioned: they are a contract with consumers (ADR-0009). Change a payload by adding a `.v2` type
 * next to the old one, never by editing a published shape.
 */
export interface DomainEventPayloads {
  'order.placed.v1': { orderId: string };
  'order.status_changed.v1': { orderId: string; status: OrderStatus; trackingNumber: string | null };
  'order.shipment_updated.v1': { orderId: string; trackingNumber: string };
  'payment.succeeded.v1': { orderId: string; paymentId: string; amount: string };
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
};

export function isDomainEventType(type: string): type is DomainEventType {
  return Object.prototype.hasOwnProperty.call(DOMAIN_EVENT_QUEUES, type);
}

/** Data of the job published for an outbox row. The job id is the event id, which consumers key idempotency on. */
export interface DomainEventJobData<T extends DomainEventType = DomainEventType> {
  eventId: string;
  aggregateId: string;
  payload: DomainEventPayloads[T];
}
