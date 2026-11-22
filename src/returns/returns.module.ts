import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsResolver } from './returns.resolver';
import { ReturnsRepository } from './returns.repository';
import { CommonsModule } from '../commons/commons.module';
import { RefundsService } from './refunds.service';
import { RefundsResolver } from './refunds.resolver';
import { RefundRepository } from './refund.repository';
import { OrderRefundsResolver } from './order-refunds.resolver';
import { PaymentProvidersModule } from '../payment/providers/payment-providers.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [CommonsModule, PaymentProvidersModule, OutboxModule],
  providers: [
    ReturnsService,
    ReturnsResolver,
    ReturnsRepository,
    RefundsService,
    RefundsResolver,
    RefundRepository,
    OrderRefundsResolver,
  ],
  exports: [ReturnsService],
})
export class ReturnsModule {}
