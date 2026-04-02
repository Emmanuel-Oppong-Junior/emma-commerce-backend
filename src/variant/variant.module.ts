import { Module } from '@nestjs/common';
import { VariantService } from './variant.service';
import { VariantResolver } from './variant.resolver';
import { VariantRepository } from './variant.repository';

@Module({
  providers: [VariantResolver, VariantService, VariantRepository],
})
export class VariantModule {}
