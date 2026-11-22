import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';

@ObjectType()
export class ShippingZoneEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Unique name for this shipping zone' })
  name: string;

  @Field(() => [String], { description: 'List of cities covered by this zone (case-insensitive)' })
  cities: string[];

  @Field(() => MoneyObject, { description: 'Shipping fee applied for orders delivered to cities in this zone' })
  fee: Decimal;

  @Field({ description: 'Whether this zone is currently active' })
  isActive: boolean;

  @Field({ description: 'Whether cash on delivery may be chosen for deliveries to this zone' })
  codEnabled: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
