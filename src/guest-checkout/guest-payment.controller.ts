import { Body, Controller, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { OnlinePaymentMethod } from '../payment/settings/payment-methods';
import { GuestCheckoutService } from './guest-checkout.service';

export class GuestPaymentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  orderAccessToken: string;

  @IsEnum(OnlinePaymentMethod, { message: 'paymentMethod must be CARD or MOBILE_MONEY' })
  paymentMethod: OnlinePaymentMethod;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  idempotencyKey?: string;
}

/** Opens the provider checkout of a guest order (P6-G.1), as POST /payment/initialize does for a customer's. */
@Controller('payment/guest')
export class GuestPaymentController {
  constructor(private readonly guestCheckout: GuestCheckoutService) {}

  @Auth(AuthType.None)
  @Throttle({ payment: { limit: 5, ttl: 60000 } })
  @Post('/initialize')
  initializeGuestTransaction(@Body() body: GuestPaymentDto, @Ip() clientIp: string) {
    return this.guestCheckout.initializePayment(body, clientIp);
  }
}
