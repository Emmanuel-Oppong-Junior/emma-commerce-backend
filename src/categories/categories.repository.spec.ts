import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CategoriesRepository } from './categories.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Category, Prisma } from '@prisma/client';

const mockCategory: Category = {
  id: 'cat1',
  name: 'Electronics',
  description: null,
  image: null,
  discountId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaCategory = {
  create: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaProduct = { count: jest.fn() };

const mockPrisma = {
  category: mockPrismaCategory,
  product: mockPrismaProduct,
};

describe('CategoriesRepository', () => {
  let repository: CategoriesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CategoriesRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<CategoriesRepository>(CategoriesRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a category', async () => {
      mockPrismaCategory.create.mockResolvedValue(mockCategory);

      const result = await repository.create({ name: 'Electronics' });

      expect(result).toEqual(mockCategory);
    });

    it('should throw ConflictException on P2002', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaCategory.create.mockRejectedValue(prismaError);

      await expect(repository.create({ name: 'Dup' })).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaCategory.create.mockRejectedValue(new Error('DB failure'));

      await expect(repository.create({ name: 'X' })).rejects.toThrow('DB failure');
    });
  });

  describe('findAll', () => {
    it('should return all categories', async () => {
      mockPrismaCategory.findMany.mockResolvedValue([mockCategory]);

      const result = await repository.findAll({ orderBy: { name: 'asc' } });

      expect(result).toEqual([mockCategory]);
    });
  });

  describe('findById', () => {
    it('should find a category by ID', async () => {
      mockPrismaCategory.findUnique.mockResolvedValue(mockCategory);

      const result = await repository.findById('cat1');

      expect(result).toEqual(mockCategory);
    });

    it('should return null if not found', async () => {
      mockPrismaCategory.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findFirst', () => {
    it('should find a category by where clause', async () => {
      mockPrismaCategory.findFirst.mockResolvedValue(mockCategory);

      const result = await repository.findFirst({ name: { equals: 'Electronics', mode: 'insensitive' } });

      expect(result).toEqual(mockCategory);
    });
  });

  describe('update', () => {
    it('should update a category', async () => {
      const updated = { ...mockCategory, name: 'Updated' };
      mockPrismaCategory.update.mockResolvedValue(updated);

      const result = await repository.update('cat1', { name: 'Updated' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaCategory.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaCategory.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('cat1', { name: 'Y' })).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a category', async () => {
      mockPrismaCategory.delete.mockResolvedValue(mockCategory);

      const result = await repository.delete('cat1');

      expect(result).toEqual(mockCategory);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaCategory.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors on delete', async () => {
      mockPrismaCategory.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('cat1')).rejects.toThrow('DB error');
    });
  });

  describe('countProducts', () => {
    it('should count products in a category', async () => {
      mockPrismaProduct.count.mockResolvedValue(5);

      const result = await repository.countProducts('cat1');

      expect(result).toBe(5);
      expect(mockPrismaProduct.count).toHaveBeenCalledWith({ where: { categoryId: 'cat1' } });
    });
  });
});
