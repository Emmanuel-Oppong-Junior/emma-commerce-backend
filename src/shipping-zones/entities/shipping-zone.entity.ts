import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/library';

@ObjectType()
export class ShippingZoneEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Unique name for this shipping zone' })
  name: string;

  @Field(() => [String], { description: 'List of cities covered by this zone (case-insensitive)' })
  cities: string[];

  @Field(() => Float, { description: 'Shipping fee applied for orders delivered to cities in this zone' })
  fee: Decimal;

  @Field({ description: 'Whether this zone is currently active' })
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
