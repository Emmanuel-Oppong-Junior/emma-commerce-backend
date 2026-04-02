import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentResolver } from './payment.resolver';
import { PaymentController } from './payment.controller';
import { ConfigService } from '@nestjs/config';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [PaymentResolver, PaymentService, ConfigService],
  controllers: [PaymentController],
})
export class PaymentModule {}
