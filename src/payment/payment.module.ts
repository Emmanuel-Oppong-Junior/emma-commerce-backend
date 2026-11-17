import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { PaymentController } from './payment.controller';
import { ConfigService } from '@nestjs/config';
import { CommonsModule } from '../commons/commons.module';
import { PaymentRepository } from './payment.repository';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [CommonsModule, NotificationsModule],
  providers: [PaymentResolver, PaymentService, PaymentRepository, ConfigService],
  controllers: [PaymentController],
})
export class PaymentModule {}
