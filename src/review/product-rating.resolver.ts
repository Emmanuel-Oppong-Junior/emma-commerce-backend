import { Parent, ResolveField, Resolver } from '@nestjs/graphql';
import { Product } from '../products/entities/product.entity';
import { ProductRating } from './entities/product-rating.entity';
import { ProductRatingLoader } from './review.loaders';

@Resolver(() => Product)
export class ProductRatingResolver {
  constructor(private readonly ratingLoader: ProductRatingLoader) {}

  @ResolveField(() => ProductRating, { description: 'Rating over the published reviews' })
  rating(@Parent() product: Product): Promise<ProductRating> {
    return this.ratingLoader.loader.load(product.id);
  }
}
