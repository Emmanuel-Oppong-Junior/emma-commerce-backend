import { Module } from '@nestjs/common';
import { SeoModule } from '../seo/seo.module';
import { SubCategoriesService } from './sub-categories.service';
import { SubCategoriesResolver } from './sub-categories.resolver';
import { SubCategoriesRepository } from './sub-categories.repository';

@Module({
  imports: [SeoModule],
  providers: [SubCategoriesResolver, SubCategoriesService, SubCategoriesRepository],
})
export class SubCategoriesModule {}
