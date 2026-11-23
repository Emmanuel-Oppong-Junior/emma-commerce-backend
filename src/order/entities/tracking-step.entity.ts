import { Field, ID, ObjectType } from '@nestjs/graphql';
import { OrderStatus, ShipmentStatus } from '../../generated/prisma/client';
import { OrderStatusEnum, ShipmentStatusEnum } from '../enums/order.enum';

@ObjectType({
  description:
    'One step of the tracking timeline: an order status (orderStatus set) or a shipment status (shipmentId and ' +
    'shipmentStatus set, with the shipment’s carrier and tracking number)',
})
export class TrackingStep {
  @Field()
  at: Date;

  @Field(() => OrderStatusEnum, { nullable: true })
  orderStatus: OrderStatus | null;

  @Field(() => ID, { nullable: true })
  shipmentId: string | null;

  @Field(() => ShipmentStatusEnum, { nullable: true })
  shipmentStatus: ShipmentStatus | null;

  @Field(() => String, { nullable: true })
  carrier: string | null;

  @Field(() => String, { nullable: true })
  trackingNumber: string | null;
}
