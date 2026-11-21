import { registerEnumType } from '@nestjs/graphql';

export enum OrderStatusEnum {
  PLACED = 'PLACED',
  CONFIRMED = 'CONFIRMED',
  IN_FULFILMENT = 'IN_FULFILMENT',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
  EXPIRED = 'EXPIRED',
  PAYMENT_REVIEW = 'PAYMENT_REVIEW',
}

registerEnumType(OrderStatusEnum, { name: 'OrderStatus' });

export enum ShipmentStatusEnum {
  PENDING = 'PENDING',
  PICKING = 'PICKING',
  PACKED = 'PACKED',
  READY_FOR_PICKUP = 'READY_FOR_PICKUP',
  OUT_FOR_DELIVERY = 'OUT_FOR_DELIVERY',
  DELIVERED = 'DELIVERED',
  FAILED_DELIVERY = 'FAILED_DELIVERY',
  RETURNED = 'RETURNED',
}

registerEnumType(ShipmentStatusEnum, { name: 'ShipmentStatus' });

export enum PaymentIntentStatusEnum {
  PENDING = 'PENDING',
  CAPTURED = 'CAPTURED',
  PARTIALLY_REFUNDED = 'PARTIALLY_REFUNDED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(PaymentIntentStatusEnum, { name: 'OrderPaymentStatus' });

export enum OrderPaymentMethodEnum {
  ONLINE = 'ONLINE',
  CASH_ON_DELIVERY = 'CASH_ON_DELIVERY',
}

registerEnumType(OrderPaymentMethodEnum, { name: 'OrderPaymentMethod' });

export enum FulfillmentTypeEnum {
  DELIVERY = 'DELIVERY',
  PICKUP = 'PICKUP',
}

registerEnumType(FulfillmentTypeEnum, { name: 'FulfillmentType' });

export enum OrderAdjustmentTypeEnum {
  DISCOUNT = 'DISCOUNT',
  COUPON = 'COUPON',
}

registerEnumType(OrderAdjustmentTypeEnum, { name: 'OrderAdjustmentType' });
