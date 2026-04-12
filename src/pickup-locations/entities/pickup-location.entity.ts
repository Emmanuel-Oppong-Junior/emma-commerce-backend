import { Field, ID, ObjectType } from '@nestjs/graphql';

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

  @Field()
  state: string;

  @Field()
  country: string;

  @Field({ description: 'Whether this pickup location accepts orders' })
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
