import { Test, TestingModule } from '@nestjs/testing';
import { SubCategoriesService } from './sub-categories.service';
import { SubCategoriesRepository } from './sub-categories.repository';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CreateSubCategoryInput } from './dto/create-sub-category.input';
import { UpdateSubCategoryInput } from './dto/update-sub-category.input';

const mockSubCategoriesRepository = {
  create: jest.fn(),
  findAll: jest.fn(),
  findById: jest.fn(),
  findFirst: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  countProducts: jest.fn(),
};

describe('SubCategoriesService', () => {
  let service: SubCategoriesService;
  let subCategoriesRepository: SubCategoriesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubCategoriesService,
        { provide: SubCategoriesRepository, useValue: mockSubCategoriesRepository },
      ],
    }).compile();

    service = module.get<SubCategoriesService>(SubCategoriesService);
    subCategoriesRepository = module.get<SubCategoriesRepository>(SubCategoriesRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a new subcategory', async () => {
      // Arrange
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

      mockSubCategoriesRepository.findFirst.mockResolvedValue(null);
      mockSubCategoriesRepository.create.mockResolvedValue(subcategory);

      // Act
      const result = await service.create(input);

      // Assert
      expect(subCategoriesRepository.findFirst).toHaveBeenCalledWith({
        name: { mode: 'insensitive', equals: 'Shirts' },
        categoryId: 'cat1',
      });
      expect(subCategoriesRepository.create).toHaveBeenCalledWith(input);
      expect(result).toEqual(subcategory);
    });

    it('should throw ConflictException if subcategory exists in same category', async () => {
      // Arrange
      const input: CreateSubCategoryInput = {
        name: 'Shirts',
        categoryId: 'cat1',
      };
      const existing = { id: '1', name: 'shirts', categoryId: 'cat1' };

      mockSubCategoriesRepository.findFirst.mockResolvedValue(existing);

      // Act & Assert
      await expect(service.create(input)).rejects.toThrow(
        new ConflictException('A SubCategory with the name "Shirts" already exists in category ID "cat1"'),
      );
      expect(subCategoriesRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('should return all subcategories sorted by name', async () => {
      // Arrange
      const subcategories = [
        {
          id: '1',
          name: 'Shirts',
          categoryId: 'cat1',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      mockSubCategoriesRepository.findAll.mockResolvedValue(subcategories);

      // Act
      const result = await service.findAll();

      // Assert
      expect(subCategoriesRepository.findAll).toHaveBeenCalled();
      expect(result).toEqual(subcategories);
    });
  });

  describe('findOne', () => {
    it('should return a subcategory by ID', async () => {
      // Arrange
      const subcategory = {
        id: '1',
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      mockSubCategoriesRepository.findById.mockResolvedValue(subcategory);

      // Act
      const result = await service.findOne('1');

      // Assert
      expect(subCategoriesRepository.findById).toHaveBeenCalledWith('1');
      expect(result).toEqual(subcategory);
    });

    it('should return null if subcategory not found', async () => {
      // Arrange
      mockSubCategoriesRepository.findById.mockResolvedValue(null);

      // Act
      const result = await service.findOne('999');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    it('should update an existing subcategory', async () => {
      // Arrange
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

      mockSubCategoriesRepository.findById.mockResolvedValue(existing);
      mockSubCategoriesRepository.findFirst.mockResolvedValue(null);
      mockSubCategoriesRepository.update.mockResolvedValue(updated);

      // Act
      const result = await service.update(id, input);

      // Assert
      expect(subCategoriesRepository.update).toHaveBeenCalledWith(id, input);
      expect(result).toEqual(updated);
    });

    it('should throw ConflictException if updating to an existing name in same category', async () => {
      // Arrange
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

      mockSubCategoriesRepository.findById.mockResolvedValue(existing);
      mockSubCategoriesRepository.findFirst.mockResolvedValue(conflicting);

      // Act & Assert
      await expect(service.update(id, input)).rejects.toThrow(
        new ConflictException('A SubCategory with the name "Trousers" already exists in category ID "cat1"'),
      );
    });

    it('should throw NotFoundException if subcategory does not exist', async () => {
      // Arrange
      mockSubCategoriesRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.update('999', {} as UpdateSubCategoryInput)).rejects.toThrow(
        new NotFoundException('SubCategory not found'),
      );
    });
  });

  describe('remove', () => {
    it('should remove a subcategory with no products', async () => {
      // Arrange
      const id = '1';
      const subcategory = {
        id,
        name: 'Shirts',
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockSubCategoriesRepository.findById.mockResolvedValue(subcategory);
      mockSubCategoriesRepository.countProducts.mockResolvedValue(0);
      mockSubCategoriesRepository.delete.mockResolvedValue(subcategory);

      // Act
      const result = await service.remove(id);

      // Assert
      expect(subCategoriesRepository.countProducts).toHaveBeenCalledWith(id);
      expect(subCategoriesRepository.delete).toHaveBeenCalledWith(id);
      expect(result).toEqual(subcategory);
    });

    it('should throw ConflictException if subcategory has products', async () => {
      // Arrange
      const id = '1';
      const subcategory = { id, name: 'Shirts', categoryId: 'cat1' };

      mockSubCategoriesRepository.findById.mockResolvedValue(subcategory);
      mockSubCategoriesRepository.countProducts.mockResolvedValue(1);

      // Act & Assert
      await expect(service.remove(id)).rejects.toThrow(
        new ConflictException('Cannot delete SubCategory with associated products'),
      );
    });

    it('should throw NotFoundException if subcategory does not exist', async () => {
      // Arrange
      mockSubCategoriesRepository.findById.mockResolvedValue(null);

      // Act & Assert
      await expect(service.remove('999')).rejects.toThrow(new NotFoundException('SubCategory not found'));
    });
  });
});
