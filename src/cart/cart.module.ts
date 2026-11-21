import { Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartResolver } from './cart.resolver';
import { CartRepository } from './cart.repository';

@Module({
  providers: [CartResolver, CartService, CartRepository],
  exports: [CartService],
})
export class CartModule {}
