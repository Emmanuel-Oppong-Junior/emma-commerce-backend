import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ReviewRepository } from './review.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Review } from '@prisma/client';

const mockReview = {
  id: 'review1',
  userId: 'user1',
  productId: 'prod1',
  score: 5,
  comment: 'Great product!',
  deleted: false,
  deletedAt: null,
  user: { id: 'user1', email: 'user@example.com' },
  product: { id: 'prod1', name: 'T-Shirt' },
} as unknown as Review & { user: { id: string; email: string }; product: { id: string; name: string } };

const mockPrismaReview = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaProduct = { findUnique: jest.fn() };

const mockPrisma = { review: mockPrismaReview, product: mockPrismaProduct };

describe('ReviewRepository', () => {
  let repository: ReviewRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ReviewRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<ReviewRepository>(ReviewRepository);
    jest.clearAllMocks();
  });

  describe('findProductById', () => {
    it('should find a product by ID', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue({ id: 'prod1' });

      const result = await repository.findProductById('prod1');

      expect(result).toEqual({ id: 'prod1' });
    });

    it('should return null if product not found', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(null);

      const result = await repository.findProductById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findExisting', () => {
    it('should find an existing review for user and product', async () => {
      mockPrismaReview.findFirst.mockResolvedValue(mockReview);

      const result = await repository.findExisting('user1', 'prod1');

      expect(result).toEqual(mockReview);
    });

    it('should return null if no existing review', async () => {
      mockPrismaReview.findFirst.mockResolvedValue(null);

      const result = await repository.findExisting('user1', 'prod1');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a review with user and product includes', async () => {
      mockPrismaReview.create.mockResolvedValue(mockReview);

      const result = await repository.create({
        user: { connect: { id: 'user1' } },
        product: { connect: { id: 'prod1' } },
        score: 5,
        comment: 'Great!',
      });

      expect(result).toEqual(mockReview);
      expect(mockPrismaReview.create).toHaveBeenCalledWith(
        expect.objectContaining({ include: expect.objectContaining({ user: expect.any(Object) }) }),
      );
    });
  });

  describe('findById', () => {
    it('should find a review by ID with includes', async () => {
      mockPrismaReview.findUnique.mockResolvedValue(mockReview);

      const result = await repository.findById('review1');

      expect(result).toEqual(mockReview);
    });

    it('should return null if not found', async () => {
      mockPrismaReview.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByProduct', () => {
    it('should return all reviews for a product', async () => {
      mockPrismaReview.findMany.mockResolvedValue([mockReview]);

      const result = await repository.findByProduct('prod1');

      expect(result).toEqual([mockReview]);
      expect(mockPrismaReview.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: 'prod1' } }),
      );
    });
  });

  describe('findByUser', () => {
    it('should return all reviews by a user', async () => {
      mockPrismaReview.findMany.mockResolvedValue([mockReview]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockReview]);
      expect(mockPrismaReview.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user1' } }));
    });
  });

  describe('update', () => {
    it('should update a review', async () => {
      const updated = { ...mockReview, comment: 'Updated comment', score: 4 };
      mockPrismaReview.update.mockResolvedValue(updated);

      const result = await repository.update('review1', { score: 4, comment: 'Updated comment' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaReview.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { score: 3, comment: 'x' })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaReview.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('review1', { score: 3, comment: 'x' })).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a review', async () => {
      mockPrismaReview.delete.mockResolvedValue(mockReview);

      const result = await repository.delete('review1');

      expect(result).toEqual(mockReview);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaReview.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors on delete', async () => {
      mockPrismaReview.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('review1')).rejects.toThrow('DB error');
    });
  });
});
