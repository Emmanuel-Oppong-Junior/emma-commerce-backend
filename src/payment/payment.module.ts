import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { PaymentController } from './payment.controller';
import { ConfigService } from '@nestjs/config';
import { CommonsModule } from '../commons/commons.module';
import { PaymentRepository } from './payment.repository';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaystackClient } from './paystack.client';
import { WebhookEventRepository } from './webhook-event.repository';
import { OutboxModule } from '../outbox/outbox.module';
import { OrderModule } from '../order/order.module';
import { StoreModule } from '../store/store.module';
import { PaymentReconciliationService } from './payment-reconciliation.service';

@Module({
  imports: [CommonsModule, OutboxModule, OrderModule, StoreModule],
  providers: [
    PaymentResolver,
    PaymentService,
    PaymentRepository,
    PaymentWebhookService,
    WebhookEventRepository,
    PaystackClient,
    PaymentReconciliationService,
    ConfigService,
  ],
  controllers: [PaymentController],
  exports: [PaymentReconciliationService, PaymentWebhookService],
})
export class PaymentModule {}
