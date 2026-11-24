import { Field, GraphQLISODateTime, ID, Int, ObjectType } from '@nestjs/graphql';
import { CurrencyEnum } from '../../products/enums/product.enum';

@ObjectType({ description: 'The settings of the store this deployment serves' })
export class StoreSettings {
  @Field(() => ID)
  id: string;

  @Field()
  legalName: string;

  @Field()
  tradingName: string;

  @Field(() => String, { nullable: true, description: 'Taxpayer Identification Number' })
  tin: string | null;

  @Field()
  vatRegistered: boolean;

  @Field({ description: 'Whether product prices already include tax' })
  pricesIncludeTax: boolean;

  @Field(() => CurrencyEnum, { description: 'Currency of every price, charge and refund' })
  currency: CurrencyEnum;

  @Field(() => String, { nullable: true })
  supportEmail: string | null;

  @Field(() => String, { nullable: true })
  supportPhone: string | null;

  @Field(() => Int, {
    description: 'Days after delivery goods may be returned in, unless their product type sets its own',
  })
  returnWindowDays: number;

  @Field(() => GraphQLISODateTime)
  createdAt: Date;

  @Field(() => GraphQLISODateTime)
  updatedAt: Date;
}
