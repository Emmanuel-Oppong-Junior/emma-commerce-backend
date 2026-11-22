import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, NotEquals } from 'class-validator';
import { StockAdjustmentReason } from '../../generated/prisma/client';

@InputType()
export class AdjustVariantStockInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => ID, { nullable: true, description: 'Stock location; defaults to the store’s default location' })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => Int, {
    description: 'Signed change to on-hand stock, never an absolute quantity: negative removes, positive adds',
  })
  @IsInt()
  @NotEquals(0)
  delta: number;

  @Field(() => StockAdjustmentReason, {
    description:
      'DAMAGED, LOST and EXPIRED only remove stock, FOUND only adds it, CORRECTION and OTHER go either way; STOCK_TAKE is refused (approved stock-takes only)',
  })
  @IsEnum(StockAdjustmentReason)
  reason: StockAdjustmentReason;

  @Field({ nullable: true, description: 'Free text; required when the reason is OTHER' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
