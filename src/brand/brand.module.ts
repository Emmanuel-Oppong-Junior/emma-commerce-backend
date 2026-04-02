import { Module } from '@nestjs/common';
import { BrandService } from './brand.service';
import { BrandResolver } from './brand.resolver';
import { BrandRepository } from './brand.repository';

@Module({
  providers: [BrandResolver, BrandService, BrandRepository],
})
export class BrandModule {}
