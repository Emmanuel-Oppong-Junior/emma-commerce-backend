import { Module } from '@nestjs/common';
import { OrdersService } from './order.service';
import { OrdersResolver } from './order.resolver';
import { CartModule } from '../cart/cart.module';
import { DiscountModule } from '../discount/discount.module';
import { CommonsModule } from '../commons/commons.module';

@Module({
  providers: [OrdersService, OrdersResolver],
  imports: [CartModule, DiscountModule, CommonsModule],
})
export class OrderModule {}
