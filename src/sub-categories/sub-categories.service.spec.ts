import { Test, TestingModule } from '@nestjs/testing';
import { SubCategoriesService } from './sub-categories.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CreateSubCategoryInput } from './dto/create-sub-category.input';
import { UpdateSubCategoryInput } from './dto/update-sub-category.input';

const mockPrismaService = {
  subCategory: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  product: {
    count: jest.fn(),
  },
};

describe('SubCategoriesService', () => {
  let service: SubCategoriesService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SubCategoriesService, { provide: PrismaService, useValue: mockPrismaService }],
    }).compile();

    service = module.get<SubCategoriesService>(SubCategoriesService);
    prisma = module.get<PrismaService>(PrismaService);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new subcategory', async () => {
      const input: CreateSubCategoryInput = {
        name: 'Shirts',
        categoryId: 'cat1',
        image: 'https://example.com/shirts.jpg',
        description: 'Shirt subcategory',
      };
      const subcategory = {
        id: '1',
        ...input,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.subCategory.findFirst.mockResolvedValue(null);
      mockPrismaService.subCategory.create.mockResolvedValue(subcategory);

      const result = await service.create(input);

      expect(prisma.subCategory.findFirst).toHaveBeenCalledWith({
        where: {
          name: { mode: 'insensitive', equals: 'Shirts' },
          categoryId: 'cat1',
        },
      });
      expect(prisma.subCategory.create).toHaveBeenCalledWith({ data: input });
      expect(result).toEqual(subcategory);
    });

    it('should throw ConflictException if subcategory exists in same category', async () => {
      const input: CreateSubCategoryInput = {
        name: 'Shirts',
        categoryId: 'cat1',
      };
      const existing = { id: '1', name: 'shirts', categoryId: 'cat1' };

      mockPrismaService.subCategory.findFirst.mockResolvedValue(existing);

      await expect(service.create(input)).rejects.toThrow(
        new ConflictException('A SubCategory with the name "Shirts" already exists in category ID "cat1"'),
      );
    });
  });

  describe('findAll', () => {
    it('should return all subcategories sorted by name', async () => {
      const subcategories = [
        {
          id: '1',
          name: 'Shirts',
          categoryId: 'cat1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockPrismaService.subCategory.findMany.mockResolvedValue(subcategories);

      const result = await service.findAll();

      expect(prisma.subCategory.findMany).toHaveBeenCalledWith({
        include: { category: true },
        orderBy: { name: 'asc' },
      });
      expect(result).toEqual(subcategories);
    });
  });

  describe('findOne', () => {
    it('should return a subcategory by ID', async () => {
      const subcategory = {
        id: '1',
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockPrismaService.subCategory.findUnique.mockResolvedValue(subcategory);

      const result = await service.findOne('1');

      expect(prisma.subCategory.findUnique).toHaveBeenCalledWith({
        where: { id: '1' },
      });
      expect(result).toEqual(subcategory);
    });

    it('should return null if subcategory not found', async () => {
      mockPrismaService.subCategory.findUnique.mockResolvedValue(null);

      const result = await service.findOne('999');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update an existing subcategory', async () => {
      const id = '1';
      const input: UpdateSubCategoryInput = {
        name: 'Updated Shirts',
        description: 'Updated',
      };
      const existing = {
        id,
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const updated = { ...existing, ...input, updatedAt: new Date() };

      mockPrismaService.subCategory.findUnique.mockResolvedValue(existing);
      mockPrismaService.subCategory.findFirst.mockResolvedValue(null);
      mockPrismaService.subCategory.update.mockResolvedValue(updated);

      const result = await service.update(id, input);

      expect(prisma.subCategory.update).toHaveBeenCalledWith({
        where: { id },
        data: input,
      });
      expect(result).toEqual(updated);
    });

    it('should throw ConflictException if updating to an existing name in same category', async () => {
      const id = '1';
      const input: UpdateSubCategoryInput = { name: 'Trousers' };
      const existing = {
        id,
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const conflicting = { id: '2', name: 'trousers', categoryId: 'cat1' };

      mockPrismaService.subCategory.findUnique.mockResolvedValue(existing);
      mockPrismaService.subCategory.findFirst.mockResolvedValue(conflicting);

      await expect(service.update(id, input)).rejects.toThrow(
        new ConflictException('A SubCategory with the name "Trousers" already exists in category ID "cat1"'),
      );
    });

    it('should throw NotFoundException if subcategory does not exist', async () => {
      mockPrismaService.subCategory.findUnique.mockResolvedValue(null);
      await expect(service.update('999', {} as UpdateSubCategoryInput)).rejects.toThrow(
        new NotFoundException('SubCategory not found'),
      );
    });
  });

  describe('remove', () => {
    it('should remove a subcategory with no products', async () => {
      const id = '1';
      const subcategory = {
        id,
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockPrismaService.subCategory.findUnique.mockResolvedValue(subcategory);
      mockPrismaService.product.count.mockResolvedValue(0);
      mockPrismaService.subCategory.delete.mockResolvedValue(subcategory);

      const result = await service.remove(id);

      expect(prisma.product.count).toHaveBeenCalledWith({
        where: { subcategoryId: id },
      });
      expect(prisma.subCategory.delete).toHaveBeenCalledWith({ where: { id } });
      expect(result).toEqual(subcategory);
    });

    it('should throw ConflictException if subcategory has products', async () => {
      const id = '1';
      const subcategory = { id, name: 'Shirts', categoryId: 'cat1' };

      mockPrismaService.subCategory.findUnique.mockResolvedValue(subcategory);
      mockPrismaService.product.count.mockResolvedValue(1);

      await expect(service.remove(id)).rejects.toThrow(
        new ConflictException('Cannot delete SubCategory with associated products'),
      );
    });

    it('should throw NotFoundException if subcategory does not exist', async () => {
      mockPrismaService.subCategory.findUnique.mockResolvedValue(null);

      await expect(service.remove('999')).rejects.toThrow(new NotFoundException('SubCategory not found'));
    });
  });
});
