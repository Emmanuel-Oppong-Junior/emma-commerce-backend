import { Field, ID, InputType } from '@nestjs/graphql';
import { IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { DecimalInputField, IsMoneyAmount } from '../../commons/money/decimal.scalar';
import { Decimal } from '@prisma/client/runtime/client';

@InputType()
export class CreateVariantInput {
  @Field({ nullable: true, description: 'Size of the variant' })
  @IsOptional()
  @IsString({ message: 'Size must be a string' })
  size?: string;

  @Field({ nullable: true, description: 'Color of the variant' })
  @IsOptional()
  @IsString({ message: 'Color must be a string' })
  color?: string;

  @Field({ description: 'Quantity in stock' })
  @IsNotEmpty({ message: 'Quantity must not be empty' })
  @IsNumber({}, { message: 'Quantity must be a number' })
  @Min(0)
  quantity: number;

  @DecimalInputField({ description: 'Price of the variant' })
  @IsMoneyAmount()
  price: Decimal;

  @Field(() => ID, { description: 'ID of the associated product' })
  @IsNotEmpty({ message: 'Product ID must not be empty' })
  productId: string;

  @Field(() => ID, {
    nullable: true,
    description: 'ID of the associated discount',
  })
  @IsOptional()
  discountId?: string;
}
