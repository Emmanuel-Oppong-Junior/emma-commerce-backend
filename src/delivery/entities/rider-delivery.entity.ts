import { Field, Float, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { ShipmentStatus } from '../../generated/prisma/client';
import { MoneyObject } from '../../commons/money/money.object';
import { ShipmentStatusEnum } from '../../order/enums/order.enum';

@ObjectType({ description: 'A staff member who delivers shipments (their role holds delivery.ride)' })
export class DeliveryRider {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true })
  name: string | null;

  @Field(() => String, { nullable: true })
  phoneNumber: string | null;
}

@ObjectType({ description: 'Where a delivery goes, as the customer gave it when ordering' })
export class RiderDeliveryAddress {
  @Field(() => String, { nullable: true })
  street: string | null;

  @Field(() => String, { nullable: true })
  area: string | null;

  @Field(() => String, { nullable: true })
  city: string | null;

  @Field(() => String, { nullable: true })
  region: string | null;

  @Field(() => String, { nullable: true })
  landmark: string | null;

  @Field(() => String, { nullable: true, description: 'GhanaPostGPS digital address' })
  ghanaPostGps: string | null;

  @Field(() => Float, { nullable: true })
  latitude: number | null;

  @Field(() => Float, { nullable: true })
  longitude: number | null;
}

@ObjectType({ description: 'Units of one product in a delivery' })
export class RiderDeliveryItem {
  @Field()
  productName: string;

  @Field(() => String, { nullable: true })
  sku: string | null;

  @Field(() => Int)
  quantity: number;
}

@ObjectType({
  description:
    'A shipment assigned to the signed-in rider, with only what the delivery needs: the recipient, the address, the ' +
    'items and the cash to collect',
})
export class RiderDelivery {
  @Field(() => ID)
  shipmentId: string;

  @Field(() => ShipmentStatusEnum)
  status: ShipmentStatus;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => String, { nullable: true })
  recipientName: string | null;

  @Field(() => String, { description: 'The phone to call: the delivery address phone, else the order contact phone' })
  recipientPhone: string;

  @Field(() => RiderDeliveryAddress, { nullable: true })
  address: RiderDeliveryAddress | null;

  @Field(() => [RiderDeliveryItem])
  items: RiderDeliveryItem[];

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Cash to collect on delivery (the order total); null when the order is paid online or already paid',
  })
  amountToCollect: Decimal | null;

  @Field(() => Date, { description: 'When the shipment was assigned to you' })
  assignedAt: Date;

  @Field(() => Date, { nullable: true })
  dispatchedAt: Date | null;

  @Field(() => Date, { nullable: true })
  deliveredAt: Date | null;
}
