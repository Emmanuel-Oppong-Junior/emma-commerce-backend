import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client';

const O = OrderStatus;

/**
 * The order machine (ADR-0014): PLACED (stock reserved) -> CONFIRMED (paid, or cash on delivery accepted) ->
 * IN_FULFILMENT (first fulfilment step) -> COMPLETED (delivered or collected). CANCELLED and EXPIRED close an order;
 * a payment that arrives after either moves it to PAYMENT_REVIEW until that payment is refunded (-> CANCELLED).
 */
const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PLACED: [O.CONFIRMED, O.CANCELLED, O.EXPIRED],
  CONFIRMED: [O.IN_FULFILMENT, O.CANCELLED],
  IN_FULFILMENT: [O.COMPLETED, O.CANCELLED],
  COMPLETED: [],
  CANCELLED: [O.PAYMENT_REVIEW],
  EXPIRED: [O.PAYMENT_REVIEW],
  PAYMENT_REVIEW: [O.CANCELLED],
};

/** A customer may cancel before fulfilment starts. */
export const CUSTOMER_CANCELLABLE: OrderStatus[] = [O.PLACED, O.CONFIRMED];

/** Staff may also cancel during fulfilment while the goods are still in the shop (checked on the shipment). */
export const STAFF_CANCELLABLE: OrderStatus[] = [O.PLACED, O.CONFIRMED, O.IN_FULFILMENT];

/** Closed orders that may be soft-deleted; PAYMENT_REVIEW still has money to return. */
export const DELETABLE_STATUSES: OrderStatus[] = [O.COMPLETED, O.CANCELLED, O.EXPIRED];

/** Orders whose shipment may move. */
export const FULFILLABLE_STATUSES: OrderStatus[] = [O.CONFIRMED, O.IN_FULFILMENT];

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function allowedFrom(to: OrderStatus): OrderStatus[] {
  return (Object.keys(TRANSITIONS) as OrderStatus[]).filter((from) => canTransition(from, to));
}

export function assertTransition(orderId: string, from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`Order "${orderId}" cannot move from ${from} to ${to}`);
  }
}
