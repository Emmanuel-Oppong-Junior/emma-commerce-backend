import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
  PaymentStatus,
  ShipmentStatus,
} from '../generated/prisma/client';
import { PAID_INTENT_STATUSES } from './payment-intent-status';
import { isDispatch } from '../order/shipment-status';

/**
 * Cash is handed over when the order reaches the customer, so it is recorded only for an order in fulfilment whose
 * shipment has been dispatched: out for delivery, or waiting at the pickup counter.
 */
export const COD_COLLECTABLE_FROM: OrderStatus[] = [OrderStatus.IN_FULFILMENT];

export interface CollectableOrder {
  status: OrderStatus;
  deleted: boolean;
  paymentMethod: PaymentMethod;
  paymentIntent: { status: PaymentIntentStatus; attempts: { status: PaymentStatus }[] } | null;
  shipments: { id: string; status: ShipmentStatus }[];
}

/** The dispatched shipment the cash is collected for; assertCodCollectable guarantees there is one. */
export function collectableShipment<S extends { id: string; status: ShipmentStatus }>(order: { shipments: S[] }): S {
  const shipment = order.shipments.find((candidate) => isDispatch(candidate.status));
  if (!shipment) throw new Error('No dispatched shipment; call assertCodCollectable first');
  return shipment;
}

export function assertCodCollectable<T extends CollectableOrder>(order: T | null, orderId: string): asserts order is T {
  if (!order || order.deleted) throw new NotFoundException(`Order "${orderId}" not found`);
  if (order.paymentMethod !== PaymentMethod.CASH_ON_DELIVERY) {
    throw new BadRequestException(`Order "${orderId}" is not a cash-on-delivery order`);
  }
  const intent = order.paymentIntent;
  if (
    (intent && PAID_INTENT_STATUSES.includes(intent.status)) ||
    intent?.attempts.some((attempt) => attempt.status === PaymentStatus.CAPTURED)
  ) {
    throw new ConflictException(`Payment for order "${orderId}" has already been recorded`);
  }
  if (!COD_COLLECTABLE_FROM.includes(order.status)) {
    throw new ConflictException(
      `Order "${orderId}" is ${order.status}; cash can only be recorded for a ${COD_COLLECTABLE_FROM.join(' or ')} order`,
    );
  }
  if (!order.shipments.some((shipment) => isDispatch(shipment.status))) {
    throw new ConflictException(
      `Order "${orderId}" has not been dispatched; cash can only be recorded once it is out for delivery or ready for pickup`,
    );
  }
}
