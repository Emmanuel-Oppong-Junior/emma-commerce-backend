import { Module } from '@nestjs/common';
import { ShippingZonesService } from './shipping-zones.service';
import { ShippingZonesResolver } from './shipping-zones.resolver';
import { ShippingZonesRepository } from './shipping-zones.repository';
import { AddressesModule } from '../addresses/addresses.module';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [AddressesModule, CommonsModule],
  providers: [ShippingZonesService, ShippingZonesResolver, ShippingZonesRepository],
  exports: [ShippingZonesService],
})
export class ShippingZonesModule {}
