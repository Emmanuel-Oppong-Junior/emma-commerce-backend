import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, MaxLength, NotEquals, ValidateNested } from 'class-validator';
import { LotInput } from '../lots/dto/lot.input';
import { SerialsField } from '../serials/dto/serials.field';
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

  @SerialsField(
    'One serial per unit, required when the product tracks serials (and refused otherwise): ' +
      'units in stock at the location for a removal, new or written-off serials for an addition',
  )
  serials?: string[];

  @Field({ nullable: true, description: 'Free text; required when the reason is OTHER' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @Field(() => LotInput, {
    nullable: true,
    description:
      'Lot-tracked variants only (P4-C.1): required when adding (an existing lot, or a new one with its expiry); ' +
      'optional when removing (default: first expiry first out)',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LotInput)
  lot?: LotInput;
}
