import { Module } from '@nestjs/common';
import { PickupLocationsService } from './pickup-locations.service';
import { PickupLocationsResolver } from './pickup-locations.resolver';
import { PickupLocationsRepository } from './pickup-locations.repository';

@Module({
  providers: [PickupLocationsService, PickupLocationsResolver, PickupLocationsRepository],
  exports: [PickupLocationsService],
})
export class PickupLocationsModule {}
