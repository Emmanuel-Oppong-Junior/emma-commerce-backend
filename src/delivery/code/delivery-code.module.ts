import { Module } from '@nestjs/common';
import { DeliveryCodes } from './delivery-codes.service';

/** Delivery codes on their own, so the notifications worker can issue them without the delivery module. */
@Module({
  providers: [DeliveryCodes],
  exports: [DeliveryCodes],
})
export class DeliveryCodeModule {}
