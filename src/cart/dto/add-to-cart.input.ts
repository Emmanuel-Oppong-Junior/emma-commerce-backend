import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { MAX_STOCK_QUANTITY } from '../../variant/dto/create-variant.input';

@InputType()
export class AddToCartInput {
  @Field(() => ID, { description: 'ID of the variant (SKU) to add; every product is sold through its variants' })
  @IsNotEmpty({ message: 'Variant ID is required' })
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Quantity to add' })
  @IsInt({ message: 'Quantity must be an integer' })
  @Min(1, { message: 'Quantity must be positive' })
  @Max(MAX_STOCK_QUANTITY)
  quantity: number;
}
