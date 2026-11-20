import { CreateVariantInput } from './create-variant.input';
import { Field, InputType, OmitType, PartialType } from '@nestjs/graphql';
import { IsBoolean, IsNotEmpty, IsOptional } from 'class-validator';

// Stock moves only through restockVariant/adjustVariantStock, so an edit form can't overwrite live stock. A variant
// never moves to another product (VAR-07): its order history belongs to that product.
@InputType()
export class UpdateVariantInput extends PartialType(OmitType(CreateVariantInput, ['quantity', 'productId'] as const)) {
  @Field(() => String)
  @IsNotEmpty({ message: 'Variant ID must not be empty' })
  id: string;

  @Field(() => Boolean, { nullable: true, description: 'false archives the variant: kept for history, never sold' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
