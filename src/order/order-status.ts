import { ConflictException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
  PROCESSING: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
  SHIPPED: [OrderStatus.DELIVERED],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isFinal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export const FINAL_STATUSES = (Object.keys(TRANSITIONS) as OrderStatus[]).filter(isFinal);

export function allowedFrom(to: OrderStatus): OrderStatus[] {
  return (Object.keys(TRANSITIONS) as OrderStatus[]).filter((from) => canTransition(from, to));
}

export function assertTransition(orderId: string, from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(`Order "${orderId}" cannot move from ${from} to ${to}`);
  }
}
