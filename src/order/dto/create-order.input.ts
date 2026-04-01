import { InputType, Field, ID } from '@nestjs/graphql';
import { IsNotEmpty } from 'class-validator';

@InputType()
export class CreateOrderInput {
  @Field(() => ID, {
    description: 'The ID of the shipping address for the order',
  })
  @IsNotEmpty({ message: 'Shipping address ID must not be empty' })
  shippingAddressId: string;
}
