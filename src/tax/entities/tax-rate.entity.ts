import { Field, Float, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TaxRateEntity {
  @Field(() => ID)
  id: string;

  @Field()
  country: string;

  @Field({ nullable: true })
  region?: string;

  @Field(() => Float)
  rate: number;

  @Field()
  isActive: boolean;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}
