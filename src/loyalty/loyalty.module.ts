import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { LoyaltyLedgerModule } from './loyalty-ledger.module';
import { LoyaltyService } from './loyalty.service';
import { LoyaltyResolver } from './loyalty.resolver';
import { LoyaltyExpiryTask } from './loyalty-expiry.task';

/** Loyalty points (P6-L.1): the customer and staff API and the expiry job. */
@Module({
  imports: [CommonsModule, LoyaltyLedgerModule],
  providers: [LoyaltyService, LoyaltyResolver, LoyaltyExpiryTask],
  exports: [LoyaltyExpiryTask],
})
export class LoyaltyModule {}
