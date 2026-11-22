import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Max, Min, ValidateNested } from 'class-validator';

export const MAX_COUNTS_PER_CALL = 200;

@InputType()
export class StockTakeCountInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Units found on the shelf, 0-1,000,000' })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  countedQuantity: number;
}

@InputType()
export class RecordStockTakeCountsInput {
  @Field(() => ID)
  @IsString()
  stockTakeId: string;

  @Field(() => [StockTakeCountInput], { description: `1-${MAX_COUNTS_PER_CALL} counts, each variant once` })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_COUNTS_PER_CALL)
  @ValidateNested({ each: true })
  @Type(() => StockTakeCountInput)
  counts: StockTakeCountInput[];
}
