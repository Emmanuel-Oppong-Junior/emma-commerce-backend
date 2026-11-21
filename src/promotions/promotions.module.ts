import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { PromotionsResolver } from './promotions.resolver';
import { PromotionsService } from './promotions.service';
import { PromotionsRepository } from './promotions.repository';

@Module({
  imports: [CommonsModule],
  providers: [PromotionsResolver, PromotionsService, PromotionsRepository],
  exports: [PromotionsService],
})
export class PromotionsModule {}
