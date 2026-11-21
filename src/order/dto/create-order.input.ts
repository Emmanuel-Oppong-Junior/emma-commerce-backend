import { InputType, Field } from '@nestjs/graphql';
import { IsEmail, IsPhoneNumber, Matches } from 'class-validator';
import { CheckoutQuoteInput } from './checkout-quote.input';

@InputType()
export class CreateOrderInput extends CheckoutQuoteInput {
  @Field({ description: 'Contact email for order notifications' })
  @IsEmail({}, { message: 'contactEmail must be a valid email address' })
  contactEmail: string;

  @Field({ description: 'Contact phone number for delivery coordination' })
  @IsPhoneNumber(undefined, { message: 'contactPhone must be a valid phone number' })
  contactPhone: string;

  @Field({
    description:
      'quoteHash from checkoutQuote for the same fulfilment and coupon. The order is placed only if the cart still ' +
      'prices to that quote; otherwise CONFLICT with reason QUOTE_CHANGED',
  })
  @Matches(/^[0-9a-f]{64}$/, { message: 'quoteHash must be the quoteHash returned by checkoutQuote' })
  quoteHash: string;
}
