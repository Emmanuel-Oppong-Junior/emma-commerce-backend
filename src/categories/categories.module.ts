import { Module } from '@nestjs/common';
import { SeoModule } from '../seo/seo.module';
import { CategoriesService } from './categories.service';
import { CategoriesResolver } from './categories.resolver';
import { CategoriesRepository } from './categories.repository';
import { SubCategoriesOfCategoryLoader } from './subcategories.loader';

@Module({
  imports: [SeoModule],
  providers: [CategoriesResolver, CategoriesService, CategoriesRepository, SubCategoriesOfCategoryLoader],
})
export class CategoriesModule {}
