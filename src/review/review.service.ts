import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentReportReason, ModerationStatus, Review, ReviewPhoto } from '../generated/prisma/client';
import { AuditService } from '../commons/audit.service';
import { StoreFeaturesService } from '../store-features/store-features.service';
import { CreateReviewInput } from './dto/create-review.input';
import { UpdateReviewInput } from './dto/update-review.input';
import { ModerateContentInput, ReplyToReviewInput, ReportContentInput } from './dto/review-moderation.inputs';
import { ProductReviewsArgs, ContentPageArgs } from './dto/review-list.args';
import { ReviewRepository } from './review.repository';
import { cleanText, MAX_REVIEW_PHOTOS, moderationRefusal, reportRefusal, verifyingLine } from './review-rules';

export const REVIEW_NOT_VERIFIED_PURCHASE = 'REVIEW_NOT_VERIFIED_PURCHASE';
export const REVIEW_ALREADY_EXISTS = 'REVIEW_ALREADY_EXISTS';
export const ALREADY_REPORTED = 'ALREADY_REPORTED';
export const REVIEW_PHOTO_LIMIT = 'REVIEW_PHOTO_LIMIT';

export interface ReviewViewer {
  userId?: string;
  canModerate: boolean;
}

@Injectable()
export class ReviewService {
  constructor(
    private readonly reviewRepository: ReviewRepository,
    private readonly audit: AuditService,
    private readonly features: StoreFeaturesService,
  ) {}

  /** A verified buyer's one review of a public product, published at once; the product's rating follows. */
  async createReview(userId: string, input: CreateReviewInput): Promise<Review> {
    await this.features.assertEnabled('REVIEWS');
    await this.assertPublicProduct(input.productId);
    return this.reviewRepository.transaction(async (tx) => {
      if (!(await this.reviewRepository.lockProduct(tx, input.productId))) {
        throw new NotFoundException(`Product "${input.productId}" not found`);
      }
      if (await this.reviewRepository.findOwn(tx, userId, input.productId)) {
        throw new ConflictException({
          message: `You have already reviewed product "${input.productId}": edit that review instead`,
          extensions: { reason: REVIEW_ALREADY_EXISTS },
        });
      }
      const orderItemId = verifyingLine(await this.reviewRepository.purchasedLines(tx, userId, input.productId));
      if (!orderItemId) {
        throw new ForbiddenException({
          message: `Only customers who received product "${input.productId}" can review it`,
          extensions: { reason: REVIEW_NOT_VERIFIED_PURCHASE },
        });
      }
      const review = await this.reviewRepository.create(tx, {
        userId,
        productId: input.productId,
        score: input.score,
        title: cleanText(input.title),
        comment: cleanText(input.comment),
        verifiedPurchase: true,
        orderItemId,
      });
      await this.reviewRepository.refreshRating(tx, input.productId);
      return review;
    });
  }

  async updateReview(userId: string, input: UpdateReviewInput): Promise<Review> {
    await this.features.assertEnabled('REVIEWS');
    const existing = await this.ownReview(userId, input.id);
    return this.reviewRepository.transaction(async (tx) => {
      await this.reviewRepository.lockProduct(tx, existing.productId);
      const review = await this.reviewRepository.update(tx, input.id, {
        ...(input.score != null && { score: input.score }),
        ...(input.title !== undefined && { title: cleanText(input.title) }),
        ...(input.comment !== undefined && { comment: cleanText(input.comment) }),
        editedAt: new Date(),
      });
      await this.reviewRepository.refreshRating(tx, existing.productId);
      return review;
    });
  }

  /** Deletes the caller's review for good (the customer may then write a new one). */
  async deleteReview(userId: string, reviewId: string): Promise<Review> {
    await this.features.assertEnabled('REVIEWS');
    const existing = await this.ownReview(userId, reviewId);
    return this.reviewRepository.transaction(async (tx) => {
      await this.reviewRepository.lockProduct(tx, existing.productId);
      const review = await this.reviewRepository.delete(tx, reviewId);
      await this.reviewRepository.refreshRating(tx, existing.productId);
      return review;
    });
  }

  /** A published review of a public product; its author and moderators also see it hidden. */
  async getReview(reviewId: string, viewer: ReviewViewer): Promise<Review> {
    const review = await this.reviewRepository.findById(reviewId);
    if (review && (viewer.canModerate || review.userId === viewer.userId)) return review;
    if (
      !review ||
      review.status !== ModerationStatus.PUBLISHED ||
      !(await this.reviewRepository.isPublicProduct(review.productId))
    ) {
      throw new NotFoundException(`Review "${reviewId}" not found`);
    }
    return review;
  }

  async getProductReviews(args: ProductReviewsArgs): Promise<Review[]> {
    await this.assertPublicProduct(args.productId);
    return this.reviewRepository.findPublished(args.productId, args.sort, args.first, args.after);
  }

  /** The caller's reviews in any status, newest first. */
  getUserReviews(userId: string, page: ContentPageArgs): Promise<Review[]> {
    return this.reviewRepository.findByUser(userId, page.first, page.after);
  }

  async reportReview(userId: string, input: ReportContentInput): Promise<boolean> {
    await this.features.assertEnabled('REVIEWS');
    const review = await this.getReview(input.id, { canModerate: false });
    const refusal = reportRefusal(review.userId, userId);
    if (refusal) throw new BadRequestException(refusal);
    const note = cleanText(input.note);
    if (input.reason === ContentReportReason.OTHER && !note) {
      throw new BadRequestException('A note is required when the reason is OTHER');
    }
    if (await this.reviewRepository.findReport(review.id, userId)) {
      throw new ConflictException({
        message: `You have already reported review "${review.id}"`,
        extensions: { reason: ALREADY_REPORTED },
      });
    }
    await this.reviewRepository.transaction((tx) =>
      this.reviewRepository.createReport(tx, { reviewId: review.id, reporterId: userId, reason: input.reason, note }),
    );
    return true;
  }

  getReportedReviews(page: ContentPageArgs) {
    return this.reviewRepository.findReported(page.first, page.after);
  }

  /** Hides a review from every public read and from the product's rating; closes its open reports. */
  hideReview(actorId: string, input: ModerateContentInput): Promise<Review> {
    return this.moderate(actorId, input, 'HIDE');
  }

  unhideReview(actorId: string, input: ModerateContentInput): Promise<Review> {
    return this.moderate(actorId, input, 'UNHIDE');
  }

  /** Closes the review's open reports and leaves it as it is. */
  async dismissReviewReports(actorId: string, input: ModerateContentInput): Promise<Review> {
    const review = await this.existingReview(input.id);
    await this.reviewRepository.transaction(async (tx) => {
      const dismissed = await this.reviewRepository.resolveReports(tx, review.id, new Date());
      await this.audit.log(
        {
          entity: 'Review',
          entityId: review.id,
          action: 'UPDATE',
          userId: actorId,
          details: { dismissedReports: dismissed, reason: input.reason },
        },
        tx,
      );
    });
    return review;
  }

  async replyToReview(actorId: string, input: ReplyToReviewInput): Promise<Review> {
    const existing = await this.existingReview(input.reviewId);
    return this.reviewRepository.transaction(async (tx) => {
      const review = await this.reviewRepository.update(tx, existing.id, { reply: input.body, repliedAt: new Date() });
      await this.audit.log(
        {
          entity: 'Review',
          entityId: review.id,
          action: 'UPDATE',
          userId: actorId,
          details: { reply: { from: existing.reply, to: review.reply } },
        },
        tx,
      );
      return review;
    });
  }

  /** Checks before uploading that the caller owns the review and it has room for another photo. */
  async assertCanAddPhoto(userId: string, reviewId: string): Promise<void> {
    await this.features.assertEnabled('REVIEWS');
    await this.ownReview(userId, reviewId);
    await this.reviewRepository.transaction(async (tx) => this.assertPhotoRoom(tx, reviewId));
  }

  async attachPhoto(userId: string, reviewId: string, upload: { publicId: string; url: string }): Promise<ReviewPhoto> {
    await this.ownReview(userId, reviewId);
    return this.reviewRepository.transaction(async (tx) => {
      await this.reviewRepository.lockReview(tx, reviewId);
      await this.assertPhotoRoom(tx, reviewId);
      return this.reviewRepository.addPhoto(tx, { reviewId, ...upload });
    });
  }

  async removePhoto(userId: string, photoId: string): Promise<boolean> {
    await this.features.assertEnabled('REVIEWS');
    const photo = await this.reviewRepository.findPhoto(photoId);
    if (!photo || photo.review.userId !== userId) throw new NotFoundException(`Review photo "${photoId}" not found`);
    await this.reviewRepository.deletePhoto(photoId);
    return true;
  }

  private async moderate(actorId: string, input: ModerateContentInput, action: 'HIDE' | 'UNHIDE'): Promise<Review> {
    const existing = await this.existingReview(input.id);
    return this.reviewRepository.transaction(async (tx) => {
      await this.reviewRepository.lockProduct(tx, existing.productId);
      const current = await this.reviewRepository.findById(existing.id, tx);
      if (!current) throw new NotFoundException(`Review "${input.id}" not found`);
      const refusal = moderationRefusal(current.status, action);
      if (refusal) throw new ConflictException(`Review "${current.id}": ${refusal}`);
      const now = new Date();
      const review = await this.reviewRepository.update(
        tx,
        current.id,
        action === 'HIDE'
          ? { status: ModerationStatus.HIDDEN, hiddenAt: now, hiddenReason: input.reason }
          : { status: ModerationStatus.PUBLISHED, hiddenAt: null, hiddenReason: null },
      );
      const resolvedReports = action === 'HIDE' ? await this.reviewRepository.resolveReports(tx, current.id, now) : 0;
      await this.reviewRepository.refreshRating(tx, current.productId);
      await this.audit.log(
        {
          entity: 'Review',
          entityId: current.id,
          action: 'STATUS_CHANGE',
          userId: actorId,
          details: { from: current.status, to: review.status, reason: input.reason, resolvedReports },
        },
        tx,
      );
      return review;
    });
  }

  private async assertPhotoRoom(tx: Parameters<Parameters<ReviewRepository['transaction']>[0]>[0], reviewId: string) {
    if ((await this.reviewRepository.countPhotos(tx, reviewId)) >= MAX_REVIEW_PHOTOS) {
      throw new BadRequestException({
        message: `A review has at most ${MAX_REVIEW_PHOTOS} photos: remove one first`,
        extensions: { reason: REVIEW_PHOTO_LIMIT },
      });
    }
  }

  private async assertPublicProduct(productId: string): Promise<void> {
    if (!(await this.reviewRepository.isPublicProduct(productId))) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
  }

  private async existingReview(reviewId: string): Promise<Review> {
    const review = await this.reviewRepository.findById(reviewId);
    if (!review) throw new NotFoundException(`Review "${reviewId}" not found`);
    return review;
  }

  private async ownReview(userId: string, reviewId: string): Promise<Review> {
    const review = await this.existingReview(reviewId);
    if (review.userId !== userId) throw new ForbiddenException('You can only modify your own reviews');
    return review;
  }
}
