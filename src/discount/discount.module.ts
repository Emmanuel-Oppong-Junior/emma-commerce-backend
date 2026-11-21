import { Module } from '@nestjs/common';
import { DiscountService } from './discount.service';
import { DiscountResolver } from './discount.resolver';
import { DiscountRepository } from './discount.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [DiscountResolver, DiscountService, DiscountRepository],
  exports: [DiscountService],
})
export class DiscountModule {}
