import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum, OrderStatusEnum } from '../enums/order.enum';
import { FulfillmentType, OrderStatus, PaymentMethod } from '../../generated/prisma/client';
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

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Sum of item prices charged at order time, after product discounts; null on older orders',
  })
  subtotal?: Decimal;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Shipping fee charged at order time (0 for pickup); null on older orders',
  })
  shippingFee?: Decimal;

  @Field(() => MoneyObject, { description: 'Amount charged: subtotal + shippingFee - couponDiscount' })
  totalAmount: Decimal;

  @Field(() => MoneyObject, { description: 'Product discounts taken off the list prices at checkout', nullable: true })
  discountTotal?: Decimal;

  @Field(() => MoneyObject, { description: 'Final total after discounts', nullable: true })
  finalTotal?: Decimal;

  @Field(() => MoneyObject, { nullable: true, description: 'Coupon discount amount' })
  couponDiscount?: Decimal;

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

  @Field(() => GraphQLJSON, { nullable: true, description: 'Address snapshot at time of order' })
  shippingAddressSnapshot?: Record<string, unknown>;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: 'Pickup location (name, address, city, state, country) at time of order',
  })
  pickupLocationSnapshot?: Record<string, unknown>;

  @Field({ nullable: true, description: 'Shipment tracking number' })
  trackingNumber?: string;

  @Field({ nullable: true, description: 'Carrier name' })
  carrier?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => User, { nullable: true })
  user?: User;

  @Field(() => [OrderItem])
  items: OrderItem[];
}
