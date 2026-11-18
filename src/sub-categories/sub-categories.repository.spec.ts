import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { SubCategoriesRepository } from './sub-categories.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, SubCategory } from '../generated/prisma/client';

const mockSubCategory: SubCategory = {
  id: 'subcat1',
  name: 'Phones',
  description: null,
  image: null,
  categoryId: 'cat1',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaSubCategory = {
  create: jest.fn(),
  findMany: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaProduct = { count: jest.fn() };

const mockPrisma = { subCategory: mockPrismaSubCategory, product: mockPrismaProduct };

describe('SubCategoriesRepository', () => {
  let repository: SubCategoriesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SubCategoriesRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<SubCategoriesRepository>(SubCategoriesRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a subcategory', async () => {
      mockPrismaSubCategory.create.mockResolvedValue(mockSubCategory);

      const result = await repository.create({ name: 'Phones', categoryId: 'cat1' });

      expect(result).toEqual(mockSubCategory);
      expect(mockPrismaSubCategory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Phones',
            category: { connect: { id: 'cat1' } },
          }),
        }),
      );
    });

    it('should throw ConflictException on P2002', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaSubCategory.create.mockRejectedValue(prismaError);

      await expect(repository.create({ name: 'Phones', categoryId: 'cat1' })).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaSubCategory.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ name: 'X', categoryId: 'cat1' })).rejects.toThrow('DB error');
    });
  });

  describe('findAll', () => {
    it('should return all subcategories with categories', async () => {
      mockPrismaSubCategory.findMany.mockResolvedValue([mockSubCategory]);

      const result = await repository.findAll();

      expect(result).toEqual([mockSubCategory]);
      expect(mockPrismaSubCategory.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { category: true } }),
      );
    });
  });

  describe('findById', () => {
    it('should find a subcategory by ID', async () => {
      mockPrismaSubCategory.findUnique.mockResolvedValue(mockSubCategory);

      const result = await repository.findById('subcat1');

      expect(result).toEqual(mockSubCategory);
    });

    it('should return null if not found', async () => {
      mockPrismaSubCategory.findUnique.mockResolvedValue(null);

      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findFirst', () => {
    it('should find a subcategory by where clause', async () => {
      mockPrismaSubCategory.findFirst.mockResolvedValue(mockSubCategory);

      const result = await repository.findFirst({
        name: { equals: 'Phones', mode: 'insensitive' },
        categoryId: 'cat1',
      });

      expect(result).toEqual(mockSubCategory);
    });
  });

  describe('update', () => {
    it('should update a subcategory', async () => {
      const updated = { ...mockSubCategory, name: 'Tablets' };
      mockPrismaSubCategory.update.mockResolvedValue(updated);

      const result = await repository.update('subcat1', { name: 'Tablets' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaSubCategory.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaSubCategory.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('subcat1', { name: 'X' })).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a subcategory', async () => {
      mockPrismaSubCategory.delete.mockResolvedValue(mockSubCategory);

      const result = await repository.delete('subcat1');

      expect(result).toEqual(mockSubCategory);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaSubCategory.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaSubCategory.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('subcat1')).rejects.toThrow('DB error');
    });
  });

  describe('countProducts', () => {
    it('should count products in a subcategory', async () => {
      mockPrismaProduct.count.mockResolvedValue(7);

      const result = await repository.countProducts('subcat1');

      expect(result).toBe(7);
      expect(mockPrismaProduct.count).toHaveBeenCalledWith({ where: { subcategoryId: 'subcat1' } });
    });
  });
});
