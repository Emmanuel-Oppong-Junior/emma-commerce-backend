import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum, OrderStatusEnum } from '../enums/order.enum';
import {
  Currency,
  FulfillmentType,
  OrderStatus,
  PaymentIntentStatus,
  PaymentMethod,
} from '../../generated/prisma/client';
import { Shipment } from './shipment.entity';
import { CurrencyEnum } from '../../products/enums/product.enum';
import { OrderAdjustment } from './order-adjustment.entity';
import { OrderItem } from './order-item.entity';
import { Decimal } from '@prisma/client/runtime/client';
import GraphQLJSON from 'graphql-type-json';
import { User } from '../../users/entities/user.entity';
import { MoneyObject } from '../../commons/money/money.object';

@ObjectType()
export class Order {
  @Field(() => ID)
  id: string;

  @Field(() => Int, { description: 'Auto-generated sequential order reference number' })
  orderNumber: number;

  @Field(() => ID)
  userId: string;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field(() => Int, {
    description:
      '1 for orders with a full price and tax snapshot; 0 for orders placed before it, whose breakdown may be partly null',
  })
  pricingVersion: number;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Sum of unit list price x quantity, before any discount, tax included; null on some older orders',
  })
  subtotal?: Decimal | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Product discounts plus the coupon (the negated sum of the adjustments); null on some older orders',
  })
  discountTotal?: Decimal | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Tax included in the line totals; null on orders placed before tax was recorded',
  })
  taxTotal?: Decimal | null;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Shipping charged (0 for pickup); null on some older orders',
  })
  shippingTotal?: Decimal | null;

  @Field(() => MoneyObject, { description: 'Amount charged: subtotal - discountTotal + shippingTotal' })
  grandTotal: Decimal;

  @Field(() => [OrderAdjustment], { description: 'Product discounts (per line) and the coupon, as placed' })
  adjustments: OrderAdjustment[];

  @Field(() => OrderStatusEnum)
  status: OrderStatus;

  @Field(() => OrderPaymentMethodEnum, { description: 'Payment method chosen at order creation' })
  paymentMethod: PaymentMethod;

  @Field(() => FulfillmentTypeEnum, { description: 'Whether the order is for delivery or pickup' })
  fulfillmentType: FulfillmentType;

  @Field({ description: 'Contact email for order notifications' })
  contactEmail: string;

  @Field({ description: 'Contact phone number for delivery coordination' })
  contactPhone: string;

  @Field(() => ID, { nullable: true, description: 'Set when fulfillmentType is DELIVERY' })
  shippingAddressId?: string;

  @Field(() => ID, { nullable: true, description: 'Set when fulfillmentType is PICKUP' })
  pickupLocationId?: string;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description:
      'Address at time of order: recipientName, phone, region, street, city, area, landmark, ghanaPostGps, latitude, ' +
      'longitude, zipCode, country. Orders placed before Ghana addresses have state instead of the new fields.',
  })
  shippingAddressSnapshot?: Record<string, unknown>;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: 'Pickup location (name, address, city, state, country) at time of order',
  })
  pickupLocationSnapshot?: Record<string, unknown>;

  /** Resolved by OrdersResolver: shipments with carrier, tracking and history; empty until fulfilment. */
  shipments?: Shipment[];

  /** Resolved by OrdersResolver: the order payment's status; null before any payment. */
  paymentStatus?: PaymentIntentStatus | null;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => User, { nullable: true })
  user?: User;

  @Field(() => [OrderItem])
  items: OrderItem[];
}
