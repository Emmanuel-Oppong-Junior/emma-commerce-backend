import { Module } from '@nestjs/common';
import { CartService } from './cart.service';
import { CartResolver } from './cart.resolver';
import { CartRepository } from './cart.repository';
import { SavedItemsService } from './saved-items.service';
import { SavedItemsResolver } from './saved-items.resolver';
import { AbandonedCartTask } from './abandoned/abandoned-cart.task';
import { CommonsModule } from '../commons/commons.module';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [CommonsModule, OutboxModule],
  providers: [CartResolver, CartService, CartRepository, SavedItemsService, SavedItemsResolver, AbandonedCartTask],
  exports: [CartService, AbandonedCartTask],
})
export class CartModule {}
