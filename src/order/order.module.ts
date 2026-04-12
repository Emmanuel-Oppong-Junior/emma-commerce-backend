import { Module } from '@nestjs/common';
import { OrdersService } from './order.service';
import { OrdersResolver } from './order.resolver';
import { CartModule } from '../cart/cart.module';
import { DiscountModule } from '../discount/discount.module';
import { CommonsModule } from '../commons/commons.module';
import { OrdersRepository } from './order.repository';
import { CouponsModule } from '../coupons/coupons.module';
import { TaxModule } from '../tax/tax.module';
import { InventoryModule } from '../inventory/inventory.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ExpiredOrdersTask } from './tasks/expired-orders.task';

@Module({
  providers: [OrdersService, OrdersResolver, OrdersRepository, ExpiredOrdersTask],
  imports: [CartModule, DiscountModule, CommonsModule, CouponsModule, TaxModule, InventoryModule, NotificationsModule],
  exports: [OrdersService, OrdersRepository],
})
export class OrderModule {}
