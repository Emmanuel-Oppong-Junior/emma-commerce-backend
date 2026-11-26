import { Module } from '@nestjs/common';
import { SeoModule } from '../seo/seo.module';
import { BrandService } from './brand.service';
import { BrandResolver } from './brand.resolver';
import { BrandRepository } from './brand.repository';

@Module({
  imports: [SeoModule],
  providers: [BrandResolver, BrandService, BrandRepository],
})
export class BrandModule {}
