import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Review } from '@prisma/client';
import { CreateReviewInput } from './dto/create-review.input';
import { UpdateReviewInput } from './dto/update-review.input';
import { ReviewRepository } from './review.repository';

@Injectable()
export class ReviewService {
  constructor(private readonly reviewRepository: ReviewRepository) {}

  /**
   * Creates a review for a product by a user.
   * @param userId - The ID of the user.
   * @param input - The review input data.
   * @returns The created review.
   */
  async createReview(userId: string, input: CreateReviewInput): Promise<Review> {
    await this.validateProductExists(input.productId);
    await this.ensureUserHasNotReviewed(userId, input.productId);
    const { productId, score, comment } = input;
    return this.reviewRepository.create({
      user: { connect: { id: userId } },
      product: { connect: { id: productId } },
      score,
      comment,
    });
  }

  /**
   * Retrieves a specific review by ID.
   * @param reviewId - The ID of the review.
   * @returns The review with user and product details.
   */
  async getReview(reviewId: string) {
    return this.fetchReview(reviewId);
  }

  /**
   * Retrieves all reviews for a product.
   * @param productId - The ID of the product.
   * @returns List of reviews with user details.
   */
  async getProductReviews(productId: string): Promise<(Review & { user: { id: string; email: string } })[]> {
    await this.validateProductExists(productId);
    return this.reviewRepository.findByProduct(productId);
  }

  /**
   * Retrieves all reviews by a user.
   * @param userId - The ID of the user.
   * @returns List of reviews with product details.
   */
  async getUserReviews(userId: string): Promise<(Review & { product: { id: string; name: string } })[]> {
    return this.reviewRepository.findByUser(userId);
  }

  /**
   * Updates a review by the user who created it.
   * @param userId - The ID of the user.
   * @param input - The updated review input data.
   * @returns The updated review.
   */
  async updateReview(userId: string, input: UpdateReviewInput): Promise<Review> {
    const review = await this.fetchReview(input.id);
    await this.ensureUserOwnsReview(userId, review);
    return this.reviewRepository.update(input.id, {
      score: input.score ?? review.score,
      comment: input.comment ?? review.comment,
    });
  }

  /**
   * Deletes a review by the user who created it.
   * @param userId - The ID of the user.
   * @param reviewId - The ID of the review.
   * @returns The deleted review.
   */
  async deleteReview(userId: string, reviewId: string): Promise<Review> {
    const review = await this.fetchReview(reviewId);
    await this.ensureUserOwnsReview(userId, review);
    return this.reviewRepository.delete(reviewId);
  }

  async adminDeleteReview(reviewId: string): Promise<Review> {
    await this.fetchReview(reviewId);
    return this.reviewRepository.delete(reviewId);
  }

  private async validateProductExists(productId: string): Promise<void> {
    const product = await this.reviewRepository.findProductById(productId);
    if (!product) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
  }

  private async ensureUserHasNotReviewed(userId: string, productId: string): Promise<void> {
    const existingReview = await this.reviewRepository.findExisting(userId, productId);
    if (existingReview) {
      throw new BadRequestException(`You have already reviewed product "${productId}"`);
    }
  }

  private async ensureUserOwnsReview(userId: string, review: Review): Promise<void> {
    if (review.userId !== userId) {
      throw new BadRequestException(`You can only modify your own reviews`);
    }
  }

  private async fetchReview(reviewId: string) {
    const review = await this.reviewRepository.findById(reviewId);
    if (!review) throw new NotFoundException(`Review "${reviewId}" not found`);
    return review;
  }
}
