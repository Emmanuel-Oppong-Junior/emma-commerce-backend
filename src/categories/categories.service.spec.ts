import { Test, TestingModule } from '@nestjs/testing';
import { CategoriesService } from './categories.service';
import { CategoriesRepository } from './categories.repository';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CreateCategoryInput } from './dto/create-category.input';
import { UpdateCategoryInput } from './dto/update-category.input';

const mockCategoriesRepository = {
  create: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  findFirst: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  countProducts: jest.fn(),
};

const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

describe('CategoriesService', () => {
  let service: CategoriesService;
  let categoriesRepository: jest.Mocked<CategoriesRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: CategoriesRepository, useValue: mockCategoriesRepository },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
    categoriesRepository = module.get<CategoriesRepository>(CategoriesRepository) as jest.Mocked<CategoriesRepository>;
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new category', async () => {
      const input: CreateCategoryInput = {
        name: 'Clothing',
        image: 'https://example.com/clothing.jpg',
        description: 'Clothing category',
      };
      const category = { id: '1', ...input, createdAt: new Date(), updatedAt: new Date() };

      mockCategoriesRepository.findFirst.mockResolvedValue(null);
      mockCategoriesRepository.create.mockResolvedValue(category);
      mockCacheManager.del.mockResolvedValue(undefined);

      const result = await service.create(input);

      expect(categoriesRepository.findFirst).toHaveBeenCalledWith({ name: { mode: 'insensitive', equals: 'Clothing' } });
      expect(categoriesRepository.create).toHaveBeenCalledWith(input);
      expect(result).toEqual(category);
    });

    it('should throw ConflictException if category name exists (case-insensitive)', async () => {
      const input: CreateCategoryInput = { name: 'Clothing' };
      mockCategoriesRepository.findFirst.mockResolvedValue({ id: '1', name: 'clothing' });

      await expect(service.create(input)).rejects.toThrow(
        new ConflictException('A category with the name "Clothing" already exists'),
      );
    });
  });

  describe('findAll', () => {
    it('should return all categories sorted by name', async () => {
      const categories = [
        { id: '1', name: 'Clothing', createdAt: new Date(), updatedAt: new Date() },
        { id: '2', name: 'Electronics', createdAt: new Date(), updatedAt: new Date() },
      ];

      mockCacheManager.get.mockResolvedValue(null);
      mockCategoriesRepository.findAll.mockResolvedValue(categories);
      mockCacheManager.set.mockResolvedValue(undefined);

      const result = await service.findAll({ id: true, name: true });

      expect(categoriesRepository.findAll).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        select: { id: true, name: true },
      });
      expect(result).toEqual(categories);
    });

    it('should return an empty array if no categories exist', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockCategoriesRepository.findAll.mockResolvedValue([]);
      mockCacheManager.set.mockResolvedValue(undefined);

      const result = await service.findAll({ id: true, name: true, createdAt: true, updatedAt: true });

      expect(result).toEqual([]);
    });
  });

  describe('findOne', () => {
    it('should return a category by ID', async () => {
      const category = { id: '1', name: 'Clothing', createdAt: new Date(), updatedAt: new Date() };
      mockCategoriesRepository.findById.mockResolvedValue(category);

      const result = await service.findOne('1');

      expect(categoriesRepository.findById).toHaveBeenCalledWith('1');
      expect(result).toEqual(category);
    });

    it('should return null if category not found', async () => {
      mockCategoriesRepository.findById.mockResolvedValue(null);

      const result = await service.findOne('999');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update an existing category', async () => {
      const id = '1';
      const input: UpdateCategoryInput = { name: 'Updated Clothing', description: 'Updated description' };
      const existing = { id, name: 'Clothing', createdAt: new Date(), updatedAt: new Date() };
      const updated = { ...existing, ...input, updatedAt: new Date() };

      mockCategoriesRepository.findById.mockResolvedValue(existing);
      mockCategoriesRepository.findFirst.mockResolvedValue(null);
      mockCategoriesRepository.update.mockResolvedValue(updated);
      mockCacheManager.del.mockResolvedValue(undefined);

      const result = await service.update(id, input);

      expect(categoriesRepository.findById).toHaveBeenCalledWith(id);
      expect(categoriesRepository.update).toHaveBeenCalledWith(id, input);
      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException if category does not exist', async () => {
      mockCategoriesRepository.findById.mockResolvedValue(null);

      await expect(service.update('999', { name: 'Updated' })).rejects.toThrow(
        new NotFoundException('Category not found'),
      );
    });

    it('should throw ConflictException if updating to an existing name', async () => {
      const id = '1';
      const input: UpdateCategoryInput = { name: 'Electronics' };
      const existingCategory = { id, name: 'Clothing', createdAt: new Date(), updatedAt: new Date() };
      const conflictingCategory = { id: '2', name: 'electronics' };

      mockCategoriesRepository.findById.mockResolvedValue(existingCategory);
      mockCategoriesRepository.findFirst.mockResolvedValue(conflictingCategory);

      await expect(service.update(id, input)).rejects.toThrow(
        new ConflictException('A category with the name "Electronics" already exists'),
      );
    });
  });

  describe('remove', () => {
    it('should remove an existing category', async () => {
      const id = '1';
      const category = { id, name: 'Clothing', createdAt: new Date(), updatedAt: new Date() };
      mockCategoriesRepository.findById.mockResolvedValue(category);
      mockCategoriesRepository.countProducts.mockResolvedValue(0);
      mockCategoriesRepository.delete.mockResolvedValue(category);
      mockCacheManager.del.mockResolvedValue(undefined);

      const result = await service.remove(id);

      expect(categoriesRepository.findById).toHaveBeenCalledWith(id);
      expect(categoriesRepository.countProducts).toHaveBeenCalledWith(id);
      expect(categoriesRepository.delete).toHaveBeenCalledWith(id);
      expect(result).toEqual(category);
    });

    it('should throw NotFoundException if category does not exist', async () => {
      mockCategoriesRepository.findById.mockResolvedValue(null);

      await expect(service.remove('999')).rejects.toThrow(new NotFoundException('Category not found'));
    });

    it('should throw ConflictException if category has products', async () => {
      const id = '1';
      mockCategoriesRepository.findById.mockResolvedValue({ id, name: 'Clothing' });
      mockCategoriesRepository.countProducts.mockResolvedValue(1);

      await expect(service.remove(id)).rejects.toThrow(
        new ConflictException('Cannot delete category with associated products'),
      );
    });
  });

  describe('findCategoryByName', () => {
    it('should find a category by name (case-insensitive)', async () => {
      const category = { id: '1', name: 'clothing', createdAt: new Date(), updatedAt: new Date() };
      mockCategoriesRepository.findFirst.mockResolvedValue(category);

      const result = await service.findCategoryByName('Clothing');

      expect(categoriesRepository.findFirst).toHaveBeenCalledWith({ name: { mode: 'insensitive', equals: 'Clothing' } });
      expect(result).toEqual(category);
    });

    it('should return null if no category is found', async () => {
      mockCategoriesRepository.findFirst.mockResolvedValue(null);

      const result = await service.findCategoryByName('Nonexistent');

      expect(result).toBeNull();
    });
  });
});
