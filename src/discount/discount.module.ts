import { Module } from '@nestjs/common';
import { DiscountService } from './discount.service';
import { DiscountResolver } from './discount.resolver';
import { DiscountRepository } from './discount.repository';

@Module({
  providers: [DiscountResolver, DiscountService, DiscountRepository],
  exports: [DiscountService],
})
export class DiscountModule {}
