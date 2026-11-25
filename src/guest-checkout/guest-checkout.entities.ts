import { Field, ID, InputType, Int, ObjectType, OmitType } from '@nestjs/graphql';
import { Type } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateNested } from 'class-validator';
import { Decimal } from '@prisma/client/runtime/client';
import GraphQLJSON from 'graphql-type-json';
import { Currency, FulfillmentType, OrderStatus, PaymentMethod } from '../generated/prisma/client';
import { CartItem } from '../cart/entities/cart-item.entity';
import { CheckoutQuoteInput } from '../order/dto/checkout-quote.input';
import { CreateAddressInput } from '../addresses/dto/create-address.input';
import { GHANA_PHONE_FORMATS_DESCRIPTION, IsGhanaPhone } from '../commons/phone/ghana-phone';
import { FulfillmentTypeEnum, OrderPaymentMethodEnum, OrderStatusEnum } from '../order/enums/order.enum';
import { CurrencyEnum } from '../products/enums/product.enum';
import { MoneyObject } from '../commons/money/money.object';
import { OrderItem } from '../order/entities/order-item.entity';
import { OrderAdjustment } from '../order/entities/order-adjustment.entity';
import { DeliveryServiceLevel } from '../shipping-zones/enums/delivery.enums';

@ObjectType({ description: 'A guest cart (P6-G.1): shopping and checkout without an account, by its token' })
export class GuestCart {
  @Field(() => ID)
  id: string;

  @Field(() => [CartItem])
  items: CartItem[];

  @Field(() => String, { nullable: true, description: 'Last 3 digits of the phone a code was sent to, if any' })
  phoneLast3: string | null;

  @Field({ description: 'Whether that phone was verified with the SMS code (createGuestOrder needs it)' })
  phoneVerified: boolean;

  @Field({ description: 'When the cart and its token expire unless used again (each guest cart call extends it)' })
  expiresAt: Date;

  @Field()
  createdAt: Date;

  @Field()
  updatedAt: Date;
}

@ObjectType({ description: 'A new guest cart and the token every guest cart call takes' })
export class GuestCartSession {
  @Field({
    description:
      'Keep it on the device (it is shown only now and never stored by the server); it expires after 30 days unused',
  })
  guestCartToken: string;

  @Field(() => GuestCart)
  cart: GuestCart;
}

@InputType()
export class GuestPhoneInput {
  @Field({ description: `The phone to verify and place the order with: ${GHANA_PHONE_FORMATS_DESCRIPTION}` })
  @IsGhanaPhone()
  phone: string;
}

@InputType({
  description:
    'checkoutQuote for a guest cart: like CheckoutQuoteInput, with the delivery address itself instead of a saved one',
})
export class GuestCheckoutQuoteInput extends OmitType(
  CheckoutQuoteInput,
  ['shippingAddressId', 'redeemPoints'] as const,
  InputType,
) {
  @Field(() => CreateAddressInput, { nullable: true, description: 'Required when fulfillmentType is DELIVERY' })
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateAddressInput)
  shippingAddress?: CreateAddressInput;
}

@InputType()
export class CreateGuestOrderInput extends GuestCheckoutQuoteInput {
  @Field({ description: 'Who the order is for (1-100 characters)' })
  @IsString()
  @IsNotEmpty({ message: 'contactName must not be empty' })
  @MaxLength(100)
  contactName: string;

  @Field(() => String, { nullable: true, description: 'Optional: receipts and updates are emailed only when given' })
  @IsOptional()
  @IsEmail({}, { message: 'contactEmail must be a valid email address' })
  contactEmail?: string | null;

  @Field({ description: 'quoteHash from guestCheckoutQuote for the same fulfilment and coupon' })
  @Matches(/^[0-9a-f]{64}$/, { message: 'quoteHash must be the quoteHash returned by guestCheckoutQuote' })
  quoteHash: string;
}

@ObjectType({
  description:
    'A guest order as its guest sees it (P6-G.1), read with its order access token: no account, staff or actor details',
})
export class GuestOrder {
  @Field(() => ID)
  id: string;

  @Field(() => Int)
  orderNumber: number;

  @Field(() => OrderStatusEnum)
  status: OrderStatus;

  @Field(() => OrderPaymentMethodEnum)
  paymentMethod: PaymentMethod;

  @Field(() => FulfillmentTypeEnum)
  fulfillmentType: FulfillmentType;

  @Field(() => CurrencyEnum)
  currency: Currency;

  @Field(() => MoneyObject, { nullable: true })
  subtotal?: Decimal | null;

  @Field(() => MoneyObject, { nullable: true })
  discountTotal?: Decimal | null;

  @Field(() => MoneyObject, { nullable: true })
  taxTotal?: Decimal | null;

  @Field(() => MoneyObject, { nullable: true })
  shippingTotal?: Decimal | null;

  @Field(() => MoneyObject)
  grandTotal: Decimal;

  @Field(() => String, { nullable: true })
  shippingZoneName?: string | null;

  @Field(() => DeliveryServiceLevel, { nullable: true })
  serviceLevel?: DeliveryServiceLevel | null;

  @Field(() => String, { nullable: true })
  contactName?: string | null;

  @Field(() => String, { nullable: true })
  contactEmail?: string | null;

  @Field()
  contactPhone: string;

  @Field(() => GraphQLJSON, { nullable: true, description: 'The delivery address as ordered' })
  shippingAddressSnapshot?: Record<string, unknown> | null;

  @Field(() => GraphQLJSON, { nullable: true, description: 'The pickup point as ordered' })
  pickupLocationSnapshot?: Record<string, unknown> | null;

  @Field(() => [OrderItem])
  items: OrderItem[];

  @Field(() => [OrderAdjustment])
  adjustments: OrderAdjustment[];

  @Field()
  createdAt: Date;
}

@ObjectType({ description: 'The placed guest order and the token to read, pay and track it' })
export class GuestOrderPlacement {
  @Field({
    description:
      'Gives access to this order only (guestOrder, POST /payment/guest/initialize, verifyGuestPayment) and claims ' +
      'its verified phone at signUp; it is also in the order SMS and email link',
  })
  orderAccessToken: string;

  @Field(() => GuestOrder)
  order: GuestOrder;
}
