import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { StoreModule } from '../store/store.module';
import { PriceListsResolver } from './price-lists.resolver';
import { PriceListsService } from './price-lists.service';
import { PriceListsRepository } from './price-lists.repository';

@Module({
  imports: [CommonsModule, StoreModule],
  providers: [PriceListsResolver, PriceListsService, PriceListsRepository],
  exports: [PriceListsService],
})
export class PriceListsModule {}
