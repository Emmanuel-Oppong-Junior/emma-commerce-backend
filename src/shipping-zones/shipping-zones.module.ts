import { Module } from '@nestjs/common';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZonesResolver } from './shipping-zones.resolver';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { CommonsModule } from '../commons/commons.module';
import { DeliverySlotsService } from './slots/delivery-slots.service';
import { DeliverySlotsRepository } from './slots/delivery-slots.repository';
import {
  DeliverySlotsResolver,
  OrderDeliverySlotResolver,
  ShippingZoneSlotsResolver,
} from './slots/delivery-slots.resolver';

@Module({
  imports: [CommonsModule],
  providers: [
    ShippingZonesService,
    ShippingZonesResolver,
    ShippingZonesRepository,
    DeliverySlotsService,
    DeliverySlotsRepository,
    DeliverySlotsResolver,
    ShippingZoneSlotsResolver,
    OrderDeliverySlotResolver,
  ],
  exports: [ShippingZonesService, DeliverySlotsService],
})
export class ShippingZonesModule {}
