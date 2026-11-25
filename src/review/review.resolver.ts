import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { Throttle } from '@nestjs/throttler';
import { ReviewService } from './review.service';
import { ReportedReview, Review, ReviewPhoto, ReviewReply } from './entities/review.entity';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { CreateReviewInput } from './dto/create-review.input';
import { UpdateReviewInput } from './dto/update-review.input';
import { ModerateContentInput, ReplyToReviewInput, ReportContentInput } from './dto/review-moderation.inputs';
import { ContentPageArgs, ProductReviewsArgs } from './dto/review-list.args';
import { UsersLoader } from '../users/loaders/users.loader';
import { ProductsLoader } from '../products/loaders/products.loader';
import { PublicProfile, toPublicProfile } from '../users/entities/public-profile.entity';
import { Product } from '../products/entities/product.entity';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';
import { ActiveAccess, CustomerOnly, RequirePermission } from '../iam/authorization/policy.decorators';
import { hasPermission, StaffAccess } from '../iam/authorization/staff-access';
import { ReviewPhotosLoader } from './review.loaders';

export const CONTENT_WRITE_LIMIT = { contentWrite: { limit: 10, ttl: 60000 } };

@Auth(AuthType.Bearer)
@Resolver(() => Review)
export class ReviewResolver {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly usersLoader: UsersLoader,
    private readonly productsLoader: ProductsLoader,
    private readonly photosLoader: ReviewPhotosLoader,
  ) {}

  @Auth(AuthType.Optional)
  @Query(() => Review, {
    name: 'review',
    description: 'A published review of a public product; its author and moderators also see it hidden',
  })
  async getReview(
    @Args('reviewId', { type: () => String }) reviewId: string,
    @ActiveUser('id') userId: string | undefined,
    @ActiveAccess() access: StaffAccess,
  ) {
    return this.reviewService.getReview(reviewId, { userId, canModerate: hasPermission(access, 'review.moderate') });
  }

  @Auth(AuthType.Optional)
  @Query(() => [Review], {
    name: 'productReviews',
    description: 'Published reviews of a public product, a page at a time (pass the last id as after)',
  })
  async getProductReviews(@Args() args: ProductReviewsArgs) {
    return this.reviewService.getProductReviews(args);
  }

  @Query(() => [Review], {
    name: 'userReviews',
    description: "The caller's own reviews in any status (hidden ones too), newest first",
  })
  async getUserReviews(@ActiveUser('id') userId: string, @Args() page: ContentPageArgs) {
    return this.reviewService.getUserReviews(userId, page);
  }

  @RequirePermission('review.moderate')
  @Query(() => [ReportedReview], {
    name: 'reportedReviews',
    description: 'Moderation queue: reviews with open reports, oldest review first',
  })
  async getReportedReviews(@Args() page: ContentPageArgs) {
    const reviews = await this.reviewService.getReportedReviews(page);
    return reviews.map(({ reports, ...review }) => ({ review, openReports: reports }));
  }

  @CustomerOnly()
  @Throttle(CONTENT_WRITE_LIMIT)
  @Mutation(() => Review, {
    name: 'createReview',
    description:
      'Reviews a product the caller received (refused with reason REVIEW_NOT_VERIFIED_PURCHASE otherwise); one per product (REVIEW_ALREADY_EXISTS)',
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
    description: "Updates the caller's review; null or blank title/comment clears it",
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
    description: "Deletes the caller's own review for good",
  })
  async deleteReview(@ActiveUser('id') userId: string, @Args('reviewId', { type: () => String }) reviewId: string) {
    return this.reviewService.deleteReview(userId, reviewId);
  }

  @CustomerOnly()
  @Mutation(() => Boolean, {
    name: 'removeReviewPhoto',
    description: "Removes a photo from the caller's review",
  })
  async removeReviewPhoto(@ActiveUser('id') userId: string, @Args('photoId', { type: () => String }) photoId: string) {
    return this.reviewService.removePhoto(userId, photoId);
  }

  @CustomerOnly()
  @Throttle(CONTENT_WRITE_LIMIT)
  @Mutation(() => Boolean, {
    name: 'reportReview',
    description: 'Reports a published review to staff; once per customer and review (ALREADY_REPORTED)',
  })
  async reportReview(@ActiveUser('id') userId: string, @Args('input') input: ReportContentInput) {
    return this.reviewService.reportReview(userId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => Review, {
    name: 'hideReview',
    description: 'Hides a review from public reads and the rating, closing its open reports (audited)',
  })
  async hideReview(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.reviewService.hideReview(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => Review, { name: 'unhideReview', description: 'Publishes a hidden review again (audited)' })
  async unhideReview(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.reviewService.unhideReview(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => Review, {
    name: 'dismissReviewReports',
    description: "Closes a review's open reports and leaves it published (audited)",
  })
  async dismissReviewReports(@ActiveUser('id') actorId: string, @Args('input') input: ModerateContentInput) {
    return this.reviewService.dismissReviewReports(actorId, input);
  }

  @RequirePermission('review.moderate')
  @Mutation(() => Review, {
    name: 'replyToReview',
    description: "Sets the store's public reply to a review (audited)",
  })
  async replyToReview(@ActiveUser('id') actorId: string, @Args('input') input: ReplyToReviewInput) {
    return this.reviewService.replyToReview(actorId, input);
  }

  @ResolveField(() => PublicProfile)
  async user(@Parent() review: Review): Promise<PublicProfile> {
    return toPublicProfile(await this.usersLoader.loader.load(review.userId));
  }

  @ResolveField(() => Product)
  async product(@Parent() review: Review) {
    return this.productsLoader.loader.load(review.productId);
  }

  @ResolveField(() => [ReviewPhoto])
  async photos(@Parent() review: Review) {
    return this.photosLoader.loader.load(review.id);
  }

  @ResolveField(() => ReviewReply, { nullable: true })
  reply(@Parent() review: Review): ReviewReply | null {
    return review.reply && review.repliedAt ? { body: review.reply, repliedAt: review.repliedAt } : null;
  }
}
