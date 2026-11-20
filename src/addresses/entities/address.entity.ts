import { Field, Float, ID, ObjectType } from '@nestjs/graphql';
import { GhanaRegion } from '../enums/ghana-region.enum';

// recipientName, phone and region are required for new addresses but null on ones saved before they existed;
// checkout asks the customer to complete those.
@ObjectType()
export class Address {
  @Field(() => ID)
  id: string;

  @Field(() => String, { nullable: true, description: 'Name of the person receiving the delivery' })
  recipientName: string | null;

  @Field(() => String, { nullable: true, description: 'Recipient phone in E.164 form (+233XXXXXXXXX)' })
  phone: string | null;

  @Field(() => GhanaRegion, { nullable: true })
  region: GhanaRegion | null;

  @Field()
  street: string;

  @Field({ description: 'City or town' })
  city: string;

  @Field(() => String, { nullable: true, description: 'Area, neighbourhood or suburb' })
  area: string | null;

  @Field(() => String, { nullable: true, description: 'Nearby landmark and delivery directions' })
  landmark: string | null;

  @Field(() => String, { nullable: true, description: 'GhanaPostGPS digital address (XX-NNN(N)-NNNN)' })
  ghanaPostGps: string | null;

  @Field(() => Float, { nullable: true })
  latitude: number | null;

  @Field(() => Float, { nullable: true })
  longitude: number | null;

  @Field(() => String, { nullable: true })
  zipCode: string | null;

  @Field({ description: 'ISO 3166-1 alpha-2 country code (GH)' })
  country: string;

  @Field(() => ID)
  userId: string;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
