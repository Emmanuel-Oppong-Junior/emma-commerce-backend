import { Field, ID, ObjectType } from '@nestjs/graphql';
import { ShipmentStatus } from '../../generated/prisma/client';
import { ShipmentStatusEnum } from '../enums/order.enum';
import { ShipmentStatusEvent } from './order-status-event.entity';

@ObjectType({ description: 'The goods of an order on their way to the customer (one per order for now)' })
export class Shipment {
  @Field(() => ID)
  id: string;

  @Field(() => ShipmentStatusEnum)
  status: ShipmentStatus;

  @Field(() => String, { nullable: true })
  carrier?: string | null;

  @Field(() => String, { nullable: true })
  trackingNumber?: string | null;

  @Field(() => Date, { nullable: true, description: 'When it went out for delivery or became ready for pickup' })
  dispatchedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  deliveredAt?: Date | null;

  @Field(() => [ShipmentStatusEvent], { description: 'Status history, oldest first' })
  events: ShipmentStatusEvent[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
