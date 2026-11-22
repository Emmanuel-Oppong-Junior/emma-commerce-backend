import { Field, ID, InputType } from '@nestjs/graphql';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength } from 'class-validator';

export const MAX_STOCK_TAKE_VARIANTS = 500;

@InputType()
export class OpenStockTakeInput {
  @Field(() => ID, { nullable: true, description: 'Stock location to count; defaults to the store’s default location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Count the variants of this category’s products (not with variantIds); neither = every variant',
  })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @Field(() => [ID], {
    nullable: true,
    description: `Count exactly these variants, 1-${MAX_STOCK_TAKE_VARIANTS} (not with categoryId)`,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_STOCK_TAKE_VARIANTS)
  @IsString({ each: true })
  variantIds?: string[];

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
