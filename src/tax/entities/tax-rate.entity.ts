import { Field, Float, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class TaxEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Name of the tax (e.g., "VAT", "NHIS Levy")' })
  name: string;

  @Field(() => Float, { description: 'Tax rate as a decimal (e.g., 0.15 for 15%)' })
  rate: number;

  @Field()
  isActive: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
