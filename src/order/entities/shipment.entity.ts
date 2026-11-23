import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { ShipmentStatus } from '../../generated/prisma/client';
import { ShipmentStatusEnum } from '../enums/order.enum';
import { ShipmentStatusEvent } from './order-status-event.entity';
import { staffWith } from '../../iam/authorization/staff-permission.field-middleware';

@ObjectType({ description: 'Units of one order line in a shipment' })
export class ShipmentItem {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderItemId: string;

  @Field(() => Int)
  quantity: number;
}

@ObjectType({
  description:
    'Some or all of the goods of an order on their way to the customer; an order may be split into several shipments',
})
export class Shipment {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  orderId: string;

  @Field(() => ShipmentStatusEnum)
  status: ShipmentStatus;

  @Field(() => [ShipmentItem], { description: 'The order lines and units in this shipment' })
  items: ShipmentItem[];

  @Field(() => String, { nullable: true })
  carrier?: string | null;

  @Field(() => String, { nullable: true })
  trackingNumber?: string | null;

  @Field(() => Date, { nullable: true, description: 'When it went out for delivery or became ready for pickup' })
  dispatchedAt?: Date | null;

  @Field(() => Date, { nullable: true })
  deliveredAt?: Date | null;

  @Field(() => Date, { nullable: true, description: 'When it was cancelled (before dispatch)' })
  cancelledAt?: Date | null;

  @Field(() => Date, {
    nullable: true,
    description: 'When the current rider was assigned (staff)',
    middleware: [staffWith('order.view')],
  })
  assignedAt?: Date | null;

  @Field(() => [ShipmentStatusEvent], { description: 'Status history, oldest first' })
  events: ShipmentStatusEvent[];

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
