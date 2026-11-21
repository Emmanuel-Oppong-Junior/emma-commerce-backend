import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsResolver } from './returns.resolver';
import { ReturnsRepository } from './returns.repository';
import { CommonsModule } from '../commons/commons.module';
import { RefundsService } from './refunds.service';
import { RefundsResolver } from './refunds.resolver';
import { RefundRepository } from './refund.repository';
import { PaymentProvidersModule } from '../payment/providers/payment-providers.module';

@Module({
  imports: [CommonsModule, PaymentProvidersModule],
  providers: [ReturnsService, ReturnsResolver, ReturnsRepository, RefundsService, RefundsResolver, RefundRepository],
  exports: [ReturnsService],
})
export class ReturnsModule {}
