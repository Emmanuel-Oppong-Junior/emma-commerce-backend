import { Module } from '@nestjs/common';
import { AddressesResolver } from './addresses.resolver';
import { AddressesService } from './addresses.service';
import { AddressesRepository } from './addresses.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [AddressesResolver, AddressesService, AddressesRepository],
  exports: [AddressesService],
})
export class AddressesModule {}
