import { Module } from '@nestjs/common';
import { AddressesResolver } from './addresses.resolver';
import { AddressesService } from './addresses.service';
import { AddressesRepository } from './addresses.repository';

@Module({
  providers: [AddressesResolver, AddressesService, AddressesRepository],
})
export class AddressesModule {}
