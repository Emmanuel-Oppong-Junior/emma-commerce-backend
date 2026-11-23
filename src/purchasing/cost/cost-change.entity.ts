import { ArgsType, Field, ID, InputType, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { Decimal } from '@prisma/client/runtime/client';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { CostChangeSource, Currency } from '../../generated/prisma/client';
import { CurrencyEnum } from '../../products/enums/product.enum';
import { DecimalInputField, GraphQLDecimal, IsUnitCost } from '../../commons/money/decimal.scalar';

registerEnumType(CostChangeSource, {
  name: 'CostChangeSource',
  description: "What changed a variant's weighted-average cost (P4-E.1)",
  valuesMap: {
    PURCHASE_ORDER: { description: 'A delivery received against a purchase order' },
    MANUAL: { description: 'Set by staff for a variant never bought through a purchase order' },
  },
});

@ObjectType({ description: "One entry of a variant's append-only cost history (inventory.cost.view)" })
export class CostChange {
  @Field(() => ID)
  id: string;

  @Field(() => ID)
  variantId: string;

  @Field(() => GraphQLDecimal, { nullable: true, description: 'Unit cost before, 4 dp; null when it was unknown' })
  oldValue: Decimal | null;

  @Field(() => GraphQLDecimal, { description: 'Unit cost after, 4 dp, tax-exclusive' })
  newValue: Decimal;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field(() => CostChangeSource)
  source: CostChangeSource;

  @Field(() => String, { nullable: true, description: 'What caused it, e.g. PurchaseOrderReceipt' })
  refType: string | null;

  @Field(() => ID, { nullable: true })
  refId: string | null;

  @Field(() => String, { nullable: true })
  reason: string | null;

  @Field(() => ID, { nullable: true, description: 'The staff member who made or received it' })
  actorId: string | null;

  @Field()
  createdAt: Date;
}

@ObjectType()
export class CostChangePage {
  @Field(() => [CostChange])
  nodes: CostChange[];

  @Field(() => Int)
  totalCount: number;

  @Field({ description: 'Pass the last node id as `after` to read the next page' })
  hasNextPage: boolean;
}

@ArgsType()
export class CostHistoryArgs {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last entry of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@InputType()
export class SetVariantCostInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @DecimalInputField({ description: 'Tax-exclusive unit cost in the store currency, at most 4 decimal places' })
  @IsUnitCost()
  cost: Decimal;

  @Field({ description: 'Why: where the cost comes from (an old invoice, a stock count valuation...)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
