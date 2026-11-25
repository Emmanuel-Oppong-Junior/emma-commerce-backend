import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { FraudModule } from '../fraud/fraud.module';
import { ReferralsService } from './referrals.service';
import { ReferralsResolver } from './referrals.resolver';

/** Referrals (P6-L.2): codes and their entry; IamModule uses ReferralsService at sign-up. */
@Module({
  imports: [CommonsModule, FraudModule],
  providers: [ReferralsService, ReferralsResolver],
  exports: [ReferralsService],
})
export class ReferralsModule {}
