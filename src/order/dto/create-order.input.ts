import { InputType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class CreateOrderInput {
  @Field(() => ID, {
    description: 'The ID of the shipping address for the order',
  })
  @IsNotEmpty({ message: 'Shipping address ID must not be empty' })
  shippingAddressId: string;

  @Field({ nullable: true, description: 'Optional coupon code to apply to the order' })
  @IsOptional()
  @IsString()
  couponCode?: string;
}
