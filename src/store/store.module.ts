import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { StoreRepository } from './store.repository';
import { StoreService } from './store.service';
import { StoreResolver } from './store.resolver';

@Module({
  imports: [CommonsModule],
  providers: [StoreRepository, StoreService, StoreResolver],
  exports: [StoreRepository, StoreService],
})
export class StoreModule {}
