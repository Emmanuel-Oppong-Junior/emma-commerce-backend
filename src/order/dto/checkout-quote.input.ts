import { Field, ID, InputType, Int } from '@nestjs/graphql';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum } from '../enums/order.enum';
import { DeliveryServiceLevel } from '../../shipping-zones/enums/delivery.enums';
import { DeliverySlotChoiceInput } from '../../shipping-zones/slots/delivery-slots.types';
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

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

  @Field(() => DeliveryServiceLevel, {
    nullable: true,
    defaultValue: DeliveryServiceLevel.STANDARD,
    description:
      'DELIVERY only (ignored for PICKUP): one of the levels in deliveryOptions. BAD_REQUEST with reason ' +
      'DELIVERY_LEVEL_UNAVAILABLE when the zone does not offer it',
  })
  @IsOptional()
  @IsEnum(DeliveryServiceLevel)
  serviceLevel?: DeliveryServiceLevel;

  @Field(() => DeliverySlotChoiceInput, {
    nullable: true,
    description:
      'STANDARD delivery to a zone with slots (deliverySlotRequired): one of deliverySlots. BAD_REQUEST with reason ' +
      'DELIVERY_SLOT_UNAVAILABLE when it cannot be booked, CONFLICT with reason SLOT_FULL when it has no place left',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliverySlotChoiceInput)
  deliverySlot?: DeliverySlotChoiceInput;

  @Field(() => Int, {
    nullable: true,
    description:
      'Loyalty points to redeem (at most loyalty.redeemablePoints); they pay part of the goods, never delivery. ' +
      'BAD_REQUEST with reason POINTS_BELOW_MINIMUM, INSUFFICIENT_POINTS, POINTS_ABOVE_CAP, POINTS_NOT_WHOLE_PESEWAS' +
      ', or FEATURE_DISABLED with feature LOYALTY while loyalty is switched off; createOrder: CONFLICT with reason ' +
      'LOYALTY_BALANCE_CHANGED when the balance fell meanwhile',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  redeemPoints?: number;
}
