import { Module } from '@nestjs/common';
import { OrdersService } from './order.service';
import { OrdersResolver } from './order.resolver';
import { CartModule } from '../cart/cart.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { PriceListsModule } from '../price-lists/price-lists.module';
import { CommonsModule } from '../commons/commons.module';
import { OrdersRepository } from './order.repository';
import { InventoryModule } from '../inventory/inventory.module';
import { OutboxModule } from '../outbox/outbox.module';
import { ShippingZonesModule } from '../shipping-zones/shipping-zones.module';
import { PickupLocationsModule } from '../pickup-locations/pickup-locations.module';
import { ReturnsModule } from '../returns/returns.module';
import { UsersModule } from '../users/users.module';
import { StoreModule } from '../store/store.module';
import { TaxModule } from '../tax/tax.module';
import { PaymentProvidersModule } from '../payment/providers/payment-providers.module';

@Module({
  providers: [OrdersService, OrdersResolver, OrdersRepository],
  imports: [
    CartModule,
    PromotionsModule,
    PriceListsModule,
    CommonsModule,
    InventoryModule,
    OutboxModule,
    ShippingZonesModule,
    PickupLocationsModule,
    ReturnsModule,
    UsersModule,
    StoreModule,
    TaxModule,
    PaymentProvidersModule,
  ],
  exports: [OrdersService, OrdersRepository],
})
export class OrderModule {}
