import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaystackClient } from '../paystack.client';
import { PaystackAdapter } from './paystack.adapter';
import { CashOnDeliveryAdapter } from './cash-on-delivery.adapter';
import { PaymentProviderRegistry } from './payment-provider.registry';

/** Its own module so ReturnsModule can use the providers: PaymentModule imports OrderModule, which imports ReturnsModule. */
@Module({
  imports: [ConfigModule],
  providers: [PaystackClient, PaystackAdapter, CashOnDeliveryAdapter, PaymentProviderRegistry],
  exports: [PaymentProviderRegistry],
})
export class PaymentProvidersModule {}
