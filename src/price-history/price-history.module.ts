import { Module } from '@nestjs/common';
import { PriceHistoryRepository } from './price-history.repository';
import { PriceHistoryService } from './price-history.service';
import { PriceHistoryResolver, VariantPriceHistoryResolver } from './price-history.resolver';

@Module({
  providers: [PriceHistoryRepository, PriceHistoryService, PriceHistoryResolver, VariantPriceHistoryResolver],
  exports: [PriceHistoryService],
})
export class PriceHistoryModule {}
