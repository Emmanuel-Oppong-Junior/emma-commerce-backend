import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { CartModule } from '../cart/cart.module';
import { OrderModule } from '../order/order.module';
import { PaymentModule } from '../payment/payment.module';
import { PhoneVerificationModule } from '../phone-verification/phone-verification.module';
import { GuestOrderAccessModule } from './guest-order-access';
import { GuestCheckoutService } from './guest-checkout.service';
import { GuestCheckoutResolver } from './guest-checkout.resolver';
import { GuestPaymentController } from './guest-payment.controller';

@Module({
  imports: [CommonsModule, CartModule, OrderModule, PaymentModule, PhoneVerificationModule, GuestOrderAccessModule],
  providers: [GuestCheckoutService, GuestCheckoutResolver],
  controllers: [GuestPaymentController],
})
export class GuestCheckoutModule {}
