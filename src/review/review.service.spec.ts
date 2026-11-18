import { Test, TestingModule } from '@nestjs/testing';
import { ReviewService } from './review.service';
import { ReviewRepository } from './review.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Review } from '../generated/prisma/client';
import { CreateReviewInput } from './dto/create-review.input';
import { UpdateReviewInput } from './dto/update-review.input';

describe('ReviewService', () => {
  let service: ReviewService;
  let reviewRepository: ReviewRepository;

  const mockReviewRepository = {
    findProductById: jest.fn(),
    findExisting: jest.fn(),
    create: jest.fn(),
    findById: jest.fn(),
    findByProduct: jest.fn(),
    findByUser: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  };

  const mockUserId = 'user1';
  const mockProductId = 'prod1';
  const mockReviewId = 'rev1';
  const mockReview: Review & {
    user: { id: string; email: string };
    product: { id: string; name: string };
  } = {
    id: mockReviewId,
    userId: mockUserId,
    productId: mockProductId,
    score: 5,
    comment: 'Great product!',
    deleted: false,
    deletedAt: null,
    createdAt: new Date('2025-05-01'),
    updatedAt: new Date('2025-05-01'),
    user: { id: mockUserId, email: 'user1@example.com' },
    product: { id: mockProductId, name: 'T-Shirt' },
  };
  const mockProduct = { id: mockProductId, name: 'T-Shirt' };
  const createReviewInput: CreateReviewInput = {
    productId: mockProductId,
    score: 5,
    comment: 'Great product!',
  };
  const updateReviewInput: UpdateReviewInput = {
    id: mockReviewId,
    score: 4,
    comment: 'Updated review',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReviewService, { provide: ReviewRepository, useValue: mockReviewRepository }],
    }).compile();

    service = module.get<ReviewService>(ReviewService);
    reviewRepository = module.get<ReviewRepository>(ReviewRepository);
    jest.resetAllMocks();
  });

  describe('createReview', () => {
    it('should create a review successfully', async () => {
      // Arrange
      mockReviewRepository.findProductById.mockResolvedValue(mockProduct);
      mockReviewRepository.findExisting.mockResolvedValue(null);
      mockReviewRepository.create.mockResolvedValue(mockReview);

      // Act
      const result = await service.createReview(mockUserId, createReviewInput);

      // Assert
      expect(reviewRepository.findProductById).toHaveBeenCalledWith(mockProductId);
      expect(reviewRepository.findExisting).toHaveBeenCalledWith(mockUserId, mockProductId);
      expect(reviewRepository.create).toHaveBeenCalledWith({
        user: { connect: { id: mockUserId } },
        product: { connect: { id: mockProductId } },
        score: createReviewInput.score,
        comment: createReviewInput.comment,
      });
      expect(result).toEqual(mockReview);
    });

    it('should throw NotFoundException if product doesn\u2019t exist', async () => {
      // Arrange
      mockReviewRepository.findProductById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.createReview(mockUserId, createReviewInput)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(reviewRepository.findExisting).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if user already reviewed product', async () => {
      // Arrange
      mockReviewRepository.findProductById.mockResolvedValue(mockProduct);
      mockReviewRepository.findExisting.mockResolvedValue(mockReview);

      // Act & Assert
      await expect(service.createReview(mockUserId, createReviewInput)).rejects.toThrow(
        new BadRequestException(`You have already reviewed product "${mockProductId}"`),
      );
      expect(reviewRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getReview', () => {
    it('should retrieve a review by ID', async () => {
      // Arrange
      mockReviewRepository.findById.mockResolvedValue(mockReview);

      // Act
      const result = await service.getReview(mockReviewId);

      // Assert
      expect(reviewRepository.findById).toHaveBeenCalledWith(mockReviewId);
      expect(result).toEqual(mockReview);
    });

    it('should throw NotFoundException if review doesn\u2019t exist', async () => {
      // Arrange
      mockReviewRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.getReview(mockReviewId)).rejects.toThrow(
        new NotFoundException(`Review "${mockReviewId}" not found`),
      );
    });
  });

  describe('getProductReviews', () => {
    it('should retrieve all reviews for a product', async () => {
      // Arrange
      mockReviewRepository.findProductById.mockResolvedValue(mockProduct);
      mockReviewRepository.findByProduct.mockResolvedValue([mockReview]);

      // Act
      const result = await service.getProductReviews(mockProductId);

      // Assert
      expect(reviewRepository.findProductById).toHaveBeenCalledWith(mockProductId);
      expect(reviewRepository.findByProduct).toHaveBeenCalledWith(mockProductId);
      expect(result).toEqual([mockReview]);
    });

    it('should throw NotFoundException if product doesn\u2019t exist', async () => {
      // Arrange
      mockReviewRepository.findProductById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.getProductReviews(mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(reviewRepository.findByProduct).not.toHaveBeenCalled();
    });
  });

  describe('getUserReviews', () => {
    it('should retrieve all reviews by a user', async () => {
      // Arrange
      mockReviewRepository.findByUser.mockResolvedValue([mockReview]);

      // Act
      const result = await service.getUserReviews(mockUserId);

      // Assert
      expect(reviewRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual([mockReview]);
    });

    it('should return empty array if no reviews exist', async () => {
      // Arrange
      mockReviewRepository.findByUser.mockResolvedValue([]);

      // Act
      const result = await service.getUserReviews(mockUserId);

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('updateReview', () => {
    it('should update a review successfully', async () => {
      // Arrange
      const updatedReview = {
        ...mockReview,
        score: 4,
        comment: 'Updated review',
      };
      mockReviewRepository.findById.mockResolvedValue(mockReview);
      mockReviewRepository.update.mockResolvedValue(updatedReview);

      // Act
      const result = await service.updateReview(mockUserId, updateReviewInput);

      // Assert
      expect(reviewRepository.findById).toHaveBeenCalledWith(mockReviewId);
      expect(reviewRepository.update).toHaveBeenCalledWith(mockReviewId, {
        score: updateReviewInput.score,
        comment: updateReviewInput.comment,
      });
      expect(result).toEqual(updatedReview);
    });

    it('should throw NotFoundException if review doesn\u2019t exist', async () => {
      // Arrange
      mockReviewRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.updateReview(mockUserId, updateReviewInput)).rejects.toThrow(
        new NotFoundException(`Review "${mockReviewId}" not found`),
      );
      expect(reviewRepository.update).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if user doesn\u2019t own review', async () => {
      // Arrange
      const reviewByOtherUser = { ...mockReview, userId: 'user2' };
      mockReviewRepository.findById.mockResolvedValue(reviewByOtherUser);

      // Act & Assert
      await expect(service.updateReview(mockUserId, updateReviewInput)).rejects.toThrow(
        new BadRequestException(`You can only modify your own reviews`),
      );
      expect(reviewRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteReview', () => {
    it('should delete a review successfully', async () => {
      // Arrange
      mockReviewRepository.findById.mockResolvedValue(mockReview);
      mockReviewRepository.delete.mockResolvedValue(mockReview);

      // Act
      const result = await service.deleteReview(mockUserId, mockReviewId);

      // Assert
      expect(reviewRepository.findById).toHaveBeenCalledWith(mockReviewId);
      expect(reviewRepository.delete).toHaveBeenCalledWith(mockReviewId);
      expect(result).toEqual(mockReview);
    });

    it('should throw NotFoundException if review doesn\u2019t exist', async () => {
      // Arrange
      mockReviewRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.deleteReview(mockUserId, mockReviewId)).rejects.toThrow(
        new NotFoundException(`Review "${mockReviewId}" not found`),
      );
      expect(reviewRepository.delete).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if user doesn\u2019t own review', async () => {
      // Arrange
      const reviewByOtherUser = { ...mockReview, userId: 'user2' };
      mockReviewRepository.findById.mockResolvedValue(reviewByOtherUser);

      // Act & Assert
      await expect(service.deleteReview(mockUserId, mockReviewId)).rejects.toThrow(
        new BadRequestException(`You can only modify your own reviews`),
      );
      expect(reviewRepository.delete).not.toHaveBeenCalled();
    });
  });
});
