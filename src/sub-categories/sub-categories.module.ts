import { Module } from '@nestjs/common';
import { SubCategoriesService } from './sub-categories.service';
import { SubCategoriesResolver } from './sub-categories.resolver';
import { SubCategoriesRepository } from './sub-categories.repository';

@Module({
  providers: [SubCategoriesResolver, SubCategoriesService, SubCategoriesRepository],
})
export class SubCategoriesModule {}
