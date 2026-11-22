import { Module } from '@nestjs/common';
import { CommonsModule } from '../../commons/commons.module';
import { OutboxModule } from '../../outbox/outbox.module';
import { StoreModule } from '../../store/store.module';
import { CashRepository } from './cash.repository';
import { CashResolver } from './cash.resolver';
import { CashService } from './cash.service';

@Module({
  imports: [CommonsModule, OutboxModule, StoreModule],
  providers: [CashRepository, CashService, CashResolver],
})
export class CashModule {}
