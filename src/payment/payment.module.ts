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
import { NotificationsModule } from '../notifications/notifications.module';
import { OrderModule } from '../order/order.module';

@Module({
  imports: [CommonsModule, NotificationsModule, OrderModule],
  providers: [
    PaymentResolver,
    PaymentService,
    PaymentRepository,
    PaymentWebhookService,
    WebhookEventRepository,
    PaystackClient,
    ConfigService,
  ],
  controllers: [PaymentController],
})
export class PaymentModule {}
