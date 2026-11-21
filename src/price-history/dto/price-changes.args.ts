import { ArgsType, Field, ID, Int } from '@nestjs/graphql';
import { IsDate, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/** One page of price history: newest first, `after` is the id of the last row of the previous page. */
@ArgsType()
export class PriceHistoryPageArgs {
  @Field(() => Int, { defaultValue: 50, description: '1-100' })
  @IsInt()
  @Min(1)
  @Max(100)
  first: number = 50;

  @Field(() => ID, { nullable: true, description: 'Id of the last price change of the previous page' })
  @IsOptional()
  @IsString()
  after?: string;
}

@ArgsType()
export class PriceChangesArgs extends PriceHistoryPageArgs {
  @Field(() => ID, { nullable: true })
  @IsOptional()
  @IsString()
  variantId?: string;

  @Field(() => ID, { nullable: true, description: 'Price changes of every variant of the product' })
  @IsOptional()
  @IsString()
  productId?: string;

  @Field(() => Date, { nullable: true, description: 'Changes at or after this instant' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  from?: Date;

  @Field(() => Date, { nullable: true, description: 'Changes before this instant' })
  @IsOptional()
  @IsDate()
  @Type(() => Date)
  to?: Date;
}
