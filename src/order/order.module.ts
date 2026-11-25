import { LoyaltyLedgerModule } from '../loyalty/loyalty-ledger.module';
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
import { RefundsModule } from '../returns/refunds.module';
import { UsersModule } from '../users/users.module';
import { StoreModule } from '../store/store.module';
import { TaxModule } from '../tax/tax.module';
import { PaymentProvidersModule } from '../payment/providers/payment-providers.module';
import { FraudModule } from '../fraud/fraud.module';
import { CodModule } from '../cod/cod.module';
import { OrderSerialsService } from './order-serials.service';
import { OrderItemSerialsLoader, OrderItemSerialsResolver, OrderSerialsResolver } from './order-serials.resolver';
import { ShipmentsService } from './shipments.service';
import { ShipmentsRepository } from './shipments.repository';
import { ShipmentsResolver } from './shipments.resolver';
import { OrderTrackingResolver } from './order-tracking.resolver';

@Module({
  providers: [
    OrdersService,
    OrdersResolver,
    OrdersRepository,
    OrderSerialsService,
    OrderSerialsResolver,
    OrderItemSerialsResolver,
    OrderItemSerialsLoader,
    ShipmentsService,
    ShipmentsRepository,
    ShipmentsResolver,
    OrderTrackingResolver,
  ],
  imports: [
    CartModule,
    PromotionsModule,
    PriceListsModule,
    CommonsModule,
    InventoryModule,
    OutboxModule,
    ShippingZonesModule,
    PickupLocationsModule,
    RefundsModule,
    UsersModule,
    StoreModule,
    TaxModule,
    PaymentProvidersModule,
    FraudModule,
    CodModule,
    LoyaltyLedgerModule,
  ],
  exports: [OrdersService, OrdersRepository, ShipmentsService, ShipmentsRepository],
})
export class OrderModule {}
