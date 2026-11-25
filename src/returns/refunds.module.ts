import { LoyaltyLedgerModule } from '../loyalty/loyalty-ledger.module';
import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { PaymentProvidersModule } from '../payment/providers/payment-providers.module';
import { OutboxModule } from '../outbox/outbox.module';
import { DisputesModule } from '../payment/disputes/disputes.module';
import { RefundsService } from './refunds.service';
import { RefundsResolver } from './refunds.resolver';
import { RefundRepository } from './refund.repository';
import { OrderRefundsResolver } from './order-refunds.resolver';

/**
 * Refunds of order payments. Its own module so OrderModule (cancellation refunds) and ReturnsModule (return refunds,
 * which also needs OrderModule for exchanges) can both use it.
 */
@Module({
  imports: [CommonsModule, PaymentProvidersModule, OutboxModule, DisputesModule, LoyaltyLedgerModule],
  providers: [RefundsService, RefundsResolver, RefundRepository, OrderRefundsResolver],
  exports: [RefundsService, RefundRepository],
})
export class RefundsModule {}
