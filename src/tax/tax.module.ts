import { Module } from '@nestjs/common';
import { TaxService } from './tax.service';
import { TaxResolver } from './tax.resolver';
import { TaxRepository } from './tax.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [TaxService, TaxResolver, TaxRepository],
  exports: [TaxService],
})
export class TaxModule {}
