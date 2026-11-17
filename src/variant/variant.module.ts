import { Module } from '@nestjs/common';
import { VariantService } from './variant.service';
import { VariantResolver } from './variant.resolver';
import { VariantRepository } from './variant.repository';
import { CommonsModule } from '../commons/commons.module';

@Module({
  imports: [CommonsModule],
  providers: [VariantResolver, VariantService, VariantRepository],
})
export class VariantModule {}
