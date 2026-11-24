import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonsModule } from '../../commons/commons.module';
import { PaymentSettingsRepository } from '../settings/payment-settings.repository';
import { PaymentSettingsService } from '../settings/payment-settings.service';
import { PaymentSettingsResolver } from '../settings/payment-settings.resolver';
import { PaystackClient } from '../paystack.client';
import { PaystackAdapter } from './paystack.adapter';
import { CashOnDeliveryAdapter } from './cash-on-delivery.adapter';
import { PaymentProviderRegistry } from './payment-provider.registry';

/**
 * The providers and the store's payment settings. Its own module so OrderModule and RefundsModule can use them:
 * PaymentModule imports OrderModule, which imports RefundsModule.
 */
@Module({
  imports: [ConfigModule, CommonsModule],
  providers: [
    PaystackClient,
    PaystackAdapter,
    CashOnDeliveryAdapter,
    PaymentProviderRegistry,
    PaymentSettingsRepository,
    PaymentSettingsService,
    PaymentSettingsResolver,
  ],
  exports: [PaymentProviderRegistry, PaymentSettingsService],
})
export class PaymentProvidersModule {}
