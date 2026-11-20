import { Module } from '@nestjs/common';
import { VariantService } from './variant.service';
import { VariantResolver } from './variant.resolver';
import { VariantRepository } from './variant.repository';
import { CommonsModule } from '../commons/commons.module';
import { TaxModule } from '../tax/tax.module';

@Module({
  imports: [CommonsModule, TaxModule],
  providers: [VariantResolver, VariantService, VariantRepository],
  exports: [VariantService, VariantRepository],
})
export class VariantModule {}
