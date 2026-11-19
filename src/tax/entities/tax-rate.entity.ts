import { Field, GraphQLISODateTime, ID, ObjectType } from '@nestjs/graphql';
import { GraphQLDecimal } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@ObjectType()
export class TaxEntity {
  @Field(() => ID)
  id: string;

  @Field({ description: 'Name of the tax (e.g., "VAT", "NHIS Levy")' })
  name: string;

  @Field(() => GraphQLDecimal, { description: 'Tax rate as a decimal (e.g., 0.15 for 15%)' })
  rate: Decimal;

  @Field()
  isActive: boolean;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
