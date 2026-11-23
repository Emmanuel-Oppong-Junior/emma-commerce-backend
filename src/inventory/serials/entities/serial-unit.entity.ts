import { Field, GraphQLISODateTime, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { SerialFormat, SerialUnitStatus } from '../../../generated/prisma/client';

registerEnumType(SerialFormat, {
  name: 'SerialFormat',
  description: 'How serial numbers are checked: FREE_TEXT (1-64 letters, digits, - _ . /) or IMEI (15 digits, Luhn)',
});

registerEnumType(SerialUnitStatus, {
  name: 'SerialUnitStatus',
  description: 'Where a serialised unit is',
  valuesMap: {
    IN_STOCK: { description: 'On the shelf at its location' },
    ASSIGNED: { description: 'Picked for an order line; still on the shelf until dispatch' },
    SOLD: { description: 'Dispatched to the customer (or waiting at the pickup counter)' },
    IN_TRANSIT: { description: 'On a stock transfer between locations' },
    WRITTEN_OFF: { description: 'Adjusted away, or missing when its transfer was received' },
  },
});

export { SerialFormat, SerialUnitStatus };

/** A serialised unit as staff see it (P4-D.1). */
@ObjectType()
export class SerialUnit {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field({ description: 'Stored form: upper case, no spaces (an IMEI also without dashes)' })
  serial: string;

  @Field(() => SerialUnitStatus)
  status: SerialUnitStatus;

  @Field(() => ID, { nullable: true, description: 'Where the unit is, while IN_STOCK or ASSIGNED' })
  locationId: string | null;

  @Field(() => ID, { nullable: true, description: 'The order line, while ASSIGNED or SOLD' })
  orderItemId: string | null;

  @Field(() => GraphQLISODateTime)
  receivedAt: Date;

  @Field(() => GraphQLISODateTime, { nullable: true })
  soldAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true, description: 'Delivery date, when the product has a warranty' })
  warrantyStartsAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  warrantyEndsAt: Date | null;
}

/** A unit found by serial with what a warranty or theft enquiry needs (staff). */
@ObjectType()
export class SerialUnitLookup {
  @Field(() => SerialUnit)
  unit: SerialUnit;

  @Field()
  sku: string;

  @Field()
  productName: string;

  @Field(() => ID, { nullable: true, description: 'The order it was assigned to or sold on' })
  orderId: string | null;

  @Field(() => Int, { nullable: true })
  orderNumber: number | null;

  @Field(() => ID, { nullable: true, description: "The customer's user id on that order" })
  customerId: string | null;
}

/** A unit on the customer's own order line: its serial and warranty. */
@ObjectType()
export class OrderItemSerial {
  @Field()
  serial: string;

  @Field(() => SerialUnitStatus)
  status: SerialUnitStatus;

  @Field(() => GraphQLISODateTime, { nullable: true })
  soldAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  warrantyStartsAt: Date | null;

  @Field(() => GraphQLISODateTime, { nullable: true })
  warrantyEndsAt: Date | null;
}
