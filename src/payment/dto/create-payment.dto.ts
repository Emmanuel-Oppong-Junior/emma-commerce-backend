import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { CHARGE_CURRENCY } from '../constant';

export class CreatePaymentDto {
  @IsString()
  @IsNotEmpty()
  orderId: string;

  @IsString()
  @IsNotEmpty()
  paymentMethod: string;

  // Kept optional so existing clients that send "GHS" still validate; the server always charges CHARGE_CURRENCY.
  @IsOptional()
  @IsIn([CHARGE_CURRENCY], {
    message: `currency must be ${CHARGE_CURRENCY}; payments are charged in ${CHARGE_CURRENCY} only`,
  })
  currency?: string;
}
