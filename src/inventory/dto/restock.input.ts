import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { LotInput } from '../lots/dto/lot.input';
import { SerialsField } from '../serials/dto/serials.field';

@InputType()
export class RestockVariantInput {
  @Field(() => ID)
  @IsString()
  variantId: string;

  @Field(() => Int)
  @IsInt()
  @Min(1)
  quantity: number;

  @Field({ nullable: true, description: 'Why the stock came in; defaults to "Manual restock"' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @SerialsField(
    'One serial per unit, required when the product tracks serials (and refused otherwise): ' +
      "new serials for a receipt, units sold on the return's order for a return restock",
  )
  serials?: string[];

  @Field(() => ID, {
    nullable: true,
    description: 'Goods returned under this return request: recorded as RETURN_RESTOCK instead of RECEIPT',
  })
  @IsOptional()
  @IsString()
  returnRequestId?: string;

  @Field(() => ID, {
    nullable: true,
    description:
      "Where the stock is received; defaults to the location of the return's order, else the default location",
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @Field(() => LotInput, {
    nullable: true,
    description:
      'Lot-tracked variants only (P4-C.1). A receipt needs the lot number and expiry (in the future); a return restock ' +
      "may name an existing lot, else the units go back into the lots the order's sale drew from",
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => LotInput)
  lot?: LotInput;
}
