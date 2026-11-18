import { CreateProductInput } from './create-product.input';
import { Field, InputType, OmitType, PartialType } from '@nestjs/graphql';
import { IsBoolean, IsOptional } from 'class-validator';

// Stock moves only through restockProduct/adjustProductStock, so an edit form can't overwrite live stock.
// The flags are redeclared without the create defaults: an omitted flag must leave the product as it is.
@InputType()
export class UpdateProductInput extends PartialType(
  OmitType(CreateProductInput, ['quantity', 'isActive', 'isTaxable'] as const),
) {
  @Field(() => Boolean, { nullable: true, description: 'Whether taxes apply to this product' })
  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Whether the product is visible to customers' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
