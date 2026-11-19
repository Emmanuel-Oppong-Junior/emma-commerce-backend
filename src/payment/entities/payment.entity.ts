import { Field, ID, ObjectType } from '@nestjs/graphql';
import { PaymentStatus } from '../enums/payment-status.enum';
import { Order } from '../../order/entities/order.entity';
import { Decimal } from '@prisma/client/runtime/client';
import GraphQLJSON from 'graphql-type-json';
import { MoneyObject } from '../../commons/money/money.object';

@ObjectType()
export class Payment {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => Order)
  order: Order;

  @Field(() => MoneyObject)
  amount: Decimal;

  @Field(() => String)
  currency: string;

  @Field(() => String)
  paymentMethod: string;

  @Field(() => PaymentStatus)
  status: PaymentStatus;

  @Field(() => String, { nullable: true })
  transactionId?: string;

  @Field(() => GraphQLJSON, {
    nullable: true,
    description: 'Transaction audit data from the payment provider',
  })
  paymentDetails?: Record<string, unknown>;

  @Field(() => Date)
  createdAt: Date;

  @Field(() => Date)
  updatedAt: Date;
}
