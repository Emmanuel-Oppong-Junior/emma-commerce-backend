import { Module } from '@nestjs/common';
import { PickupLocationsService } from './pickup-locations.service';
import { PickupLocationsResolver } from './pickup-locations.resolver';
import { PickupLocationsRepository } from './pickup-locations.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [PickupLocationsService, PickupLocationsResolver, PickupLocationsRepository],
  exports: [PickupLocationsService],
})
export class PickupLocationsModule {}
