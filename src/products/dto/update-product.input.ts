import { CreateProductInput } from './create-product.input';
import { Field, InputType, OmitType, PartialType } from '@nestjs/graphql';
import { IsBoolean, IsOptional } from 'class-validator';

// Variants are managed with createVariant/updateVariant/deleteVariant, and their stock through restock/adjust.
// The flags are redeclared without the create defaults: an omitted flag must leave the product as it is.
@InputType()
export class UpdateProductInput extends PartialType(
  OmitType(CreateProductInput, ['variants', 'isActive', 'isTaxable'] as const),
) {
  @Field(() => Boolean, {
    nullable: true,
    description: 'Whether variant prices add tax to their basePrice; changing it reprices every variant',
  })
  @IsOptional()
  @IsBoolean()
  isTaxable?: boolean;

  @Field(() => Boolean, { nullable: true, description: 'Whether the product is visible to customers' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
