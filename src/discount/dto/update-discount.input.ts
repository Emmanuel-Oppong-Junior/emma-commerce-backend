import { Field, ID, InputType, OmitType, PartialType } from '@nestjs/graphql';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CreateDiscountInput } from './create-discount.input';

// isActive is redeclared without the create default so that omitting it leaves the discount as it is.
@InputType()
export class UpdateDiscountInput extends PartialType(OmitType(CreateDiscountInput, ['isActive'] as const)) {
  @Field(() => ID, { description: 'The ID of the discount to update' })
  @IsNotEmpty({ message: 'Discount ID is required' })
  @IsString({ message: 'Discount ID must be a string' })
  id: string;

  @Field(() => Boolean, { nullable: true, description: 'Whether the discount is active' })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
