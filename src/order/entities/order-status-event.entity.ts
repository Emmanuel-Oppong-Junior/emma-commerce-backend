import { Field, ID, ObjectType } from '@nestjs/graphql';
import { OrderStatus, ShipmentStatus } from '../../generated/prisma/client';
import { OrderStatusEnum, ShipmentStatusEnum } from '../enums/order.enum';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';

@ObjectType({ description: 'One step in the order status history (its tracking timeline)' })
export class OrderStatusEvent {
  @Field(() => ID)
  id: string;

  @Field(() => OrderStatusEnum, { nullable: true, description: 'Null for the first event (placed, or migrated)' })
  from?: OrderStatus | null;

  @Field(() => OrderStatusEnum)
  to: OrderStatus;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'Who caused it; null for the system (payment, expiry). Staff with order.view only',
    middleware: [staffWith('order.view')],
  })
  actorId?: string | null;

  @Field()
  createdAt: Date;
}

@ObjectType({ description: 'One step in a shipment status history' })
export class ShipmentStatusEvent {
  @Field(() => ID)
  id: string;

  @Field(() => ShipmentStatusEnum, { nullable: true, description: 'Null for the first event' })
  from?: ShipmentStatus | null;

  @Field(() => ShipmentStatusEnum)
  to: ShipmentStatus;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => ID, {
    nullable: true,
    description: 'Who caused it. Staff with order.view only',
    middleware: [staffWith('order.view')],
  })
  actorId?: string | null;

  @Field()
  createdAt: Date;
}
