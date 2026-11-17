import { Args, Int, Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Product } from './entities/product.entity';
import { ProductsService } from './products.service';
import { Category } from '../categories/entities/category.entity';
import { SubCategory } from '../sub-categories/entities/sub-category.entity';
import { Brand } from '../brand/entities/brand.entity';

const DEFAULT_NESTED_PRODUCTS = 20;
const firstArg = {
  type: () => Int,
  defaultValue: DEFAULT_NESTED_PRODUCTS,
  description: 'Maximum number of products to return (1–100), newest first',
};
const description = 'Active, PUBLISHED products only';

@Resolver(() => Category)
export class CategoryProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @ResolveField(() => [Product], { description })
  products(@Parent() category: Category, @Args('first', firstArg) first: number) {
    return this.productsService.findPublishedIn({ categoryId: category.id }, first);
  }
}

@Resolver(() => SubCategory)
export class SubCategoryProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @ResolveField(() => [Product], { description })
  products(@Parent() subCategory: SubCategory, @Args('first', firstArg) first: number) {
    return this.productsService.findPublishedIn({ subcategoryId: subCategory.id }, first);
  }
}

@Resolver(() => Brand)
export class BrandProductsResolver {
  constructor(private readonly productsService: ProductsService) {}

  @ResolveField(() => [Product], { description })
  products(@Parent() brand: Brand, @Args('first', firstArg) first: number) {
    return this.productsService.findPublishedIn({ brandId: brand.id }, first);
  }
}
