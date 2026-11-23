import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { Weekday } from '../../shipping-zones/enums/delivery.enums';
import { GhanaRegion } from '../../addresses/enums/ghana-region.enum';

@ObjectType({ description: 'When the point is open on a weekday (HH:MM, Africa/Accra)' })
export class OpeningHoursEntity {
  @Field(() => Weekday)
  weekday: Weekday;

  @Field()
  opens: string;

  @Field()
  closes: string;
}

@ObjectType()
export class PickupLocationEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Display name of the pickup location' })
  name: string;

  @Field({ description: 'Street address of the pickup location' })
  address: string;

  @Field()
  city: string;

  @Field(() => GhanaRegion, { nullable: true, description: 'Null only on points migrated without a matching region' })
  region: GhanaRegion | null;

  @Field()
  country: string;

  @Field(() => String, { nullable: true, description: 'E.164 number customers can call about their collection' })
  contactPhone: string | null;

  @Field(() => String, { nullable: true, description: 'How to find the counter and what to bring' })
  instructions: string | null;

  @Field(() => String, { nullable: true })
  ghanaPostGps: string | null;

  @Field(() => Float, { nullable: true })
  latitude: number | null;

  @Field(() => Float, { nullable: true })
  longitude: number | null;

  @Field(() => [OpeningHoursEntity], { description: 'Monday first; a weekday not listed is closed' })
  openingHours: OpeningHoursEntity[];

  @Field({ description: 'The week in one line, e.g. "Mon-Fri 08:00-17:00, Sat 09:00-13:00, Sun closed"' })
  openingHoursText: string;

  @Field({ description: 'Whether this pickup location accepts orders' })
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
