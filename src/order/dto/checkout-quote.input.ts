import { Field, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum } from '../enums/order.enum';

@InputType({
  description: 'What checkout prices the cart for: the fulfilment, an optional coupon and how the order will be paid',
})
export class CheckoutQuoteInput {
  @Field(() => FulfillmentTypeEnum, {
    description: 'Choose DELIVERY (requires a shipping address) or PICKUP (requires a pickup location)',
  })
  @IsEnum(FulfillmentTypeEnum)
  fulfillmentType: FulfillmentTypeEnum;

  @Field(() => ID, {
    nullable: true,
    description: 'Required when fulfillmentType is DELIVERY — the ID of the shipping address',
  })
  @IsOptional()
  @IsString()
  shippingAddressId?: string;

  @Field(() => ID, {
    nullable: true,
    description: 'Required when fulfillmentType is PICKUP — the ID of the chosen pickup location',
  })
  @IsOptional()
  @IsString()
  pickupLocationId?: string;

  @Field({ nullable: true, description: 'Optional coupon code to apply to the order' })
  @IsOptional()
  @IsString()
  couponCode?: string;

  @Field(() => OrderPaymentMethodEnum, {
    nullable: true,
    defaultValue: OrderPaymentMethodEnum.ONLINE,
    description:
      'ONLINE (pay now by card or mobile money, see availablePaymentMethods) or CASH_ON_DELIVERY. BAD_REQUEST with ' +
      'reason PAYMENT_METHOD_UNAVAILABLE when the store does not offer it',
  })
  @IsOptional()
  @IsEnum(OrderPaymentMethodEnum)
  paymentMethod?: OrderPaymentMethodEnum;
}
