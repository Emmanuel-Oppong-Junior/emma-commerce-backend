import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  paymentMethod: string;

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
