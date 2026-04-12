import { registerEnumType } from '@nestjs/graphql';

export enum OrderStatusEnum {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  SHIPPED = 'SHIPPED',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

registerEnumType(OrderStatusEnum, { name: 'OrderStatus' });

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
