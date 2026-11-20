import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ReviewService } from './review.service';
import { Review } from './entities/review.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateReviewInput } from './dto/create-review.input';
import { UpdateReviewInput } from './dto/update-review.input';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';
import { PublicProfile, toPublicProfile } from '../users/entities/public-profile.entity';
import { Product } from '../products/entities/product.entity';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { RequirePermission, CustomerOnly } from '../iam/authorization/policy.decorators';

@Auth(AuthType.Bearer)
@Resolver(() => Review)
export class ReviewResolver {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly usersLoader: UsersLoader,
    private readonly productsLoader: ProductsLoader,
  ) {}

  @Query(() => Review, {
    name: 'review',
    description: 'Retrieves a specific review by ID',
  })
  async getReview(@Args('reviewId', { type: () => String }) reviewId: string) {
    return this.reviewService.getReview(reviewId);
  }

  @Query(() => [Review], {
    name: 'productReviews',
    description: 'Retrieves all reviews for a product',
  })
  async getProductReviews(@Args('productId', { type: () => String }) productId: string) {
    return this.reviewService.getProductReviews(productId);
  }

  @Query(() => [Review], {
    name: 'userReviews',
    description: 'Retrieves all reviews by the user',
  })
  async getUserReviews(@ActiveUser('id') userId: string) {
    return this.reviewService.getUserReviews(userId);
  }
  @CustomerOnly()
  @Mutation(() => Review, {
    name: 'createReview',
    description: 'Creates a review for a product',
  })
  async createReview(
    @ActiveUser('id') userId: string,
    @Args('input', { type: () => CreateReviewInput }) input: CreateReviewInput,
  ) {
    return this.reviewService.createReview(userId, input);
  }

  @CustomerOnly()
  @Mutation(() => Review, {
    name: 'updateReview',
    description: "Updates a user's review",
  })
  async updateReview(
    @ActiveUser('id') userId: string,
    @Args('input', { type: () => UpdateReviewInput }) input: UpdateReviewInput,
  ) {
    return this.reviewService.updateReview(userId, input);
  }

  @CustomerOnly()
  @Mutation(() => Review, {
    name: 'deleteReview',
    description: "Deletes the authenticated user's own review",
  })
  async deleteReview(@ActiveUser('id') userId: string, @Args('reviewId', { type: () => String }) reviewId: string) {
    return this.reviewService.deleteReview(userId, reviewId);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => Review, {
    name: 'adminDeleteReview',
    description: 'Admin: permanently delete any review for moderation purposes',
  })
  async adminDeleteReview(@Args('reviewId', { type: () => String }) reviewId: string) {
    return this.reviewService.adminDeleteReview(reviewId);
  }

  @ResolveField(() => PublicProfile)
  async user(@Parent() review: Review): Promise<PublicProfile> {
    return toPublicProfile(await this.usersLoader.loader.load(review.userId));
  }

  @ResolveField(() => Product)
  async product(@Parent() review: Review) {
    return this.productsLoader.loader.load(review.productId);
  }
}
