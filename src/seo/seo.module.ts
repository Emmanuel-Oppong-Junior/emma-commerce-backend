import { Module } from '@nestjs/common';
import { SlugsService } from './slugs.service';
import { SlugResolutionService } from './slug-resolution.service';
import { SlugResolutionResolver } from './slug-resolution.resolver';

@Module({
  providers: [SlugsService, SlugResolutionService, SlugResolutionResolver],
  exports: [SlugsService],
})
export class SeoModule {}
