import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { OrderModule } from '../order/order.module';
import { MyDeliveriesResolver, RidersResolver, ShipmentRiderLoader } from './riders.resolver';
import { RidersRepository } from './riders.repository';
import { RidersService } from './riders.service';

/** Riders and their deliveries (P5-C). */
@Module({
  imports: [CommonsModule, OrderModule],
  providers: [RidersRepository, RidersService, RidersResolver, MyDeliveriesResolver, ShipmentRiderLoader],
})
export class DeliveryModule {}
