import { LoyaltyLedgerModule } from '../loyalty/loyalty-ledger.module';
import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { PaymentController } from './payment.controller';
import { CommonsModule } from '../commons/commons.module';
import { PaymentRepository } from './payment.repository';
import { PaymentWebhookService } from './payment-webhook.service';
import { WebhookEventRepository } from './webhook-event.repository';
import { OutboxModule } from '../outbox/outbox.module';
import { OrderModule } from '../order/order.module';
import { StoreModule } from '../store/store.module';
import { InventoryModule } from '../inventory/inventory.module';
import { PaymentReconciliationService } from './payment-reconciliation.service';
import { PaymentProvidersModule } from './providers/payment-providers.module';
import { FraudModule } from '../fraud/fraud.module';
import { DisputesModule } from './disputes/disputes.module';
import { CashModule } from './cash/cash.module';

@Module({
  imports: [
    CommonsModule,
    OutboxModule,
    OrderModule,
    StoreModule,
    InventoryModule,
    PaymentProvidersModule,
    FraudModule,
    DisputesModule,
    CashModule,
    LoyaltyLedgerModule,
  ],
  providers: [
    PaymentResolver,
    PaymentService,
    PaymentRepository,
    PaymentWebhookService,
    WebhookEventRepository,
    PaymentReconciliationService,
  ],
  controllers: [PaymentController],
  exports: [PaymentReconciliationService, PaymentWebhookService, PaymentService],
})
export class PaymentModule {}
