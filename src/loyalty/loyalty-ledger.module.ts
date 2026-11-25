import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { LoyaltyLedger } from './loyalty-ledger.service';

/**
 * The loyalty ledger on its own, so checkout (OrderModule), completion (OrderModule, PaymentModule) and refunds
 * (RefundsModule) can move points in their transactions without depending on the loyalty API.
 */
@Module({
  imports: [CommonsModule],
  providers: [LoyaltyLedger],
  exports: [LoyaltyLedger],
})
export class LoyaltyLedgerModule {}
