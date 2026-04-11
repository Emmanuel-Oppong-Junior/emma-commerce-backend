import { InputType, Field, ID } from '@nestjs/graphql';
import { IsEmail, IsEnum, IsNotEmpty, IsOptional, IsPhoneNumber, IsString } from 'class-validator';
import { OrderPaymentMethodEnum } from '../enums/order.enum';

@InputType()
export class CreateOrderInput {
  @Field(() => ID, {
    description: 'The ID of the shipping address for the order',
  })
  @IsNotEmpty({ message: 'Shipping address ID must not be empty' })
  shippingAddressId: string;

  @Field({ description: 'Contact email for order notifications' })
  @IsEmail({}, { message: 'contactEmail must be a valid email address' })
  contactEmail: string;

  @Field({ description: 'Contact phone number for delivery coordination' })
  @IsPhoneNumber(undefined, { message: 'contactPhone must be a valid phone number' })
  contactPhone: string;

  @Field({ nullable: true, description: 'Optional coupon code to apply to the order' })
  @IsOptional()
  @IsString()
  couponCode?: string;

  @Field(() => OrderPaymentMethodEnum, {
    nullable: true,
    defaultValue: OrderPaymentMethodEnum.ONLINE,
    description: 'Payment method for this order. Defaults to ONLINE (Paystack). Use CASH_ON_DELIVERY to pay on delivery.',
  })
  @IsOptional()
  @IsEnum(OrderPaymentMethodEnum)
  paymentMethod?: OrderPaymentMethodEnum;
}
