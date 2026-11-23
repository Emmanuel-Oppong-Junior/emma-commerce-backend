import { Field, ID, Int, ObjectType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { MoneyObject } from '../../commons/money/money.object';
import { GhanaRegion } from '../../addresses/enums/ghana-region.enum';
import { DeliveryServiceLevel, ZoneAreaLevel } from '../enums/delivery.enums';

@ObjectType({ description: 'A region, a town, or an area within a town that a zone delivers to' })
export class ZoneAreaEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ZoneAreaLevel)
  level: ZoneAreaLevel;

  @Field(() => GhanaRegion, { nullable: true })
  region: GhanaRegion | null;

  @Field(() => String, { nullable: true, description: 'Normalised: lower case, without accents or punctuation' })
  town: string | null;

  @Field(() => String, { nullable: true, description: 'Normalised, within town' })
  area: string | null;
}

@ObjectType()
export class WeightBandEntity {
  @Field(() => Int)
  fromGrams: number;

  @Field(() => MoneyObject)
  fee: Decimal;
}

@ObjectType({ description: "A zone's delivery fee for one service level" })
export class RateRuleEntity {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  zoneId: string;

  @Field(() => DeliveryServiceLevel)
  serviceLevel: DeliveryServiceLevel;

  @Field(() => MoneyObject, { description: 'Fee below every weight band' })
  baseFee: Decimal;

  @Field(() => MoneyObject, {
    nullable: true,
    description: 'Delivery is free once the merchandise total after promotions (tax included) reaches this',
  })
  freeAbove: Decimal | null;

  @Field(() => [WeightBandEntity], { description: 'Ascending; the heaviest band the cart reaches sets the fee' })
  weightBands: WeightBandEntity[];

  @Field()
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType()
export class ShippingZoneEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Unique name for this shipping zone' })
  name: string;

  @Field(() => [ZoneAreaEntity], { description: 'The regions, towns and areas the zone delivers to' })
  areas: ZoneAreaEntity[];

  @Field(() => [RateRuleEntity], {
    description: 'Delivery fees per service level (activeShippingZones lists the active ones only)',
  })
  rateRules: RateRuleEntity[];

  @Field({ description: 'Whether this zone is currently active' })
  isActive: boolean;

  @Field({ description: 'Whether cash on delivery may be chosen for deliveries to this zone' })
  codEnabled: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
