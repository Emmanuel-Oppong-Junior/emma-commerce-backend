import { Field, ID, InputType } from '@nestjs/graphql';
import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class ModifyDiscountItemsInput {
  @Field(() => ID, { description: 'The ID of the discount to modify' })
  @IsNotEmpty({ message: 'Discount ID is required' })
  @IsString()
  discountId: string;

  @Field(() => [ID], { description: 'Product IDs to add or remove', nullable: true, defaultValue: [] })
  @IsOptional()
  @IsArray({ message: 'Products must be an array of IDs' })
  products?: string[];

  @Field(() => [ID], { description: 'Variant IDs to add or remove', nullable: true, defaultValue: [] })
  @IsOptional()
  @IsArray({ message: 'Variants must be an array of IDs' })
  variants?: string[];

  @Field(() => [ID], { description: 'Category IDs to add or remove', nullable: true, defaultValue: [] })
  @IsOptional()
  @IsArray({ message: 'Categories must be an array of IDs' })
  categories?: string[];
}
