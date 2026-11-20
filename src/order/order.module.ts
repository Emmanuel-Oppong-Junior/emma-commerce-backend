import { Module } from '@nestjs/common';
import { OrdersService } from './order.service';
import { OrdersResolver } from './order.resolver';
import { CartModule } from '../cart/cart.module';
import { DiscountModule } from '../discount/discount.module';
import { CommonsModule } from '../commons/commons.module';
import { OrdersRepository } from './order.repository';
import { CouponsModule } from '../coupons/coupons.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ShippingZonesModule } from '../shipping-zones/shipping-zones.module';
import { PickupLocationsModule } from '../pickup-locations/pickup-locations.module';
import { ReturnsModule } from '../returns/returns.module';
import { UsersModule } from '../users/users.module';
import { StoreModule } from '../store/store.module';

@Module({
  providers: [OrdersService, OrdersResolver, OrdersRepository],
  imports: [
    CartModule,
    DiscountModule,
    CommonsModule,
    CouponsModule,
    InventoryModule,
    OutboxModule,
    ShippingZonesModule,
    PickupLocationsModule,
    ReturnsModule,
    UsersModule,
    StoreModule,
  ],
  exports: [OrdersService, OrdersRepository],
})
export class OrderModule {}
