import { Field, ID, InputType } from '@nestjs/graphql';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { FulfillmentTypeEnum } from '../enums/order.enum';

@InputType({ description: 'What checkout prices the cart for: the fulfilment and an optional coupon' })
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
}
