import { Field, InputType, Int } from '@nestjs/graphql';
import { IsNotEmpty, IsPositive, IsString } from 'class-validator';

@InputType()
export class CreateCartInput {
  @Field(() => String, { description: 'ID of the variant to add' })
  @IsNotEmpty()
  @IsString()
  variantId: string;

  @Field(() => Int, { description: 'Quantity to add' })
  @IsPositive()
  quantity: number;
}
