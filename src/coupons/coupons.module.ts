import { Module } from '@nestjs/common';
import { CouponsService } from './coupons.service';
import { CouponsResolver } from './coupons.resolver';
import { CouponsRepository } from './coupons.repository';

@Module({
  providers: [CouponsService, CouponsResolver, CouponsRepository],
  exports: [CouponsService],
})
export class CouponsModule {}
