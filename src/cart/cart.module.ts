import { Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartResolver } from './cart.resolver';
import { DiscountModule } from '../discount/discount.module';
import { CartRepository } from './cart.repository';

@Module({
  providers: [CartResolver, CartService, CartRepository],
  exports: [CartService],
  imports: [DiscountModule],
})
export class CartModule {}
