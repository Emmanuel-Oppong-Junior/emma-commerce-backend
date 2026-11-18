import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsResolver } from './returns.resolver';
import { ReturnsRepository } from './returns.repository';
import { CommonsModule } from '../commons/commons.module';
import { RefundsService } from './refunds.service';
import { RefundsResolver } from './refunds.resolver';
import { RefundRepository } from './refund.repository';
import { PaystackClient } from '../payment/paystack.client';

@Module({
  imports: [CommonsModule],
  // PaymentModule imports OrderModule, which imports this module, so the stateless client is provided here directly.
  providers: [
    ReturnsService,
    ReturnsResolver,
    ReturnsRepository,
    RefundsService,
    RefundsResolver,
    RefundRepository,
    PaystackClient,
  ],
  exports: [ReturnsService],
})
export class ReturnsModule {}
