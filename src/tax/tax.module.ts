import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';
import { TaxResolver } from './tax.resolver';
import { TaxRepository } from './tax.repository';

@Module({
  providers: [TaxService, TaxResolver, TaxRepository],
  exports: [TaxService],
})
export class TaxModule {}
