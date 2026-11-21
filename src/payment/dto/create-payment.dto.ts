import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { OnlinePaymentMethod } from '../settings/payment-methods';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsEnum(OnlinePaymentMethod, { message: 'paymentMethod must be CARD or MOBILE_MONEY' })
  paymentMethod: OnlinePaymentMethod;

  // Kept optional so existing clients that send it still work; PaymentService refuses any but the store currency.
  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey?: string;
}
