import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum, OrderStatusEnum } from '../enums/order.enum';
import { FulfillmentType, OrderStatus, PaymentMethod } from '@prisma/client';
import { OrderItem } from './order-item.entity';
import { Decimal } from '@prisma/client/runtime/library';
import GraphQLJSON from 'graphql-type-json';

@ObjectType()
export class Order {
  @Field(() => ID)
  id: string;

  @Field(() => Int, { description: 'Auto-generated sequential order reference number' })
  orderNumber: number;

  @Field(() => ID)
  userId: string;

  @Field(() => Float)
  totalAmount: Decimal;

  @Field(() => Float, { description: 'Total discount amount applied', nullable: true })
  discountTotal?: Decimal;

  @Field(() => Float, { description: 'Final total after discounts', nullable: true })
  finalTotal?: Decimal;

  @Field(() => Float, { nullable: true, description: 'Coupon discount amount' })
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

  @Field({ nullable: true, description: 'Shipment tracking number' })
  trackingNumber?: string;

  @Field({ nullable: true, description: 'Carrier name' })
  carrier?: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;

  @Field(() => [OrderItem])
  items: OrderItem[];
}
