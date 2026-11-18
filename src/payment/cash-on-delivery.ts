import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { OrderStatus, PaymentIntentStatus, PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * Cash is handed over when the order reaches the customer, so it is recorded only for a SHIPPED order: out for
 * delivery, or waiting at the pickup counter. The transition table has no PROCESSING -> DELIVERED step, so a pickup
 * order is moved to SHIPPED first like a delivery order.
 */
export const COD_COLLECTABLE_FROM: OrderStatus[] = [OrderStatus.SHIPPED];

export interface CollectableOrder {
  status: OrderStatus;
  deleted: boolean;
  paymentMethod: PaymentMethod;
  paymentIntent: { status: PaymentIntentStatus; attempts: { status: PaymentStatus }[] } | null;
}

export function assertCodCollectable<T extends CollectableOrder>(order: T | null, orderId: string): asserts order is T {
  if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
  if (order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
    throw new BadRequestException(`Order "${orderId}" is not a cash-on-delivery order`);
  }
  const intent = order.paymentIntent;
  if (
    intent?.status === PaymentIntentStatus.PAID ||
    intent?.attempts.some((attempt) => attempt.status === PaymentStatus.COMPLETED)
  ) {
    throw new ConflictException(`Payment for order "${orderId}" has already been recorded`);
  }
  if (!COD_COLLECTABLE_FROM.includes(order.status)) {
    throw new ConflictException(
      `Order "${orderId}" is ${order.status}; cash can only be recorded for a ${COD_COLLECTABLE_FROM.join(' or ')} order`,
    );
  }
}
