import { Module } from '@nestjs/common';
import { ReturnsService } from './returns.service';
import { ReturnsResolver } from './returns.resolver';
import { ReturnsRepository } from './returns.repository';
import { CommonsModule } from '../commons/commons.module';
import { OutboxModule } from '../outbox/outbox.module';
import { InventoryModule } from '../inventory/inventory.module';
import { OrderModule } from '../order/order.module';
import { RefundsModule } from './refunds.module';
import { ReturnPhotoController } from './return-photo.controller';

@Module({
  imports: [CommonsModule, OutboxModule, InventoryModule, OrderModule, RefundsModule],
  controllers: [ReturnPhotoController],
  providers: [ReturnsService, ReturnsResolver, ReturnsRepository],
})
export class ReturnsModule {}
