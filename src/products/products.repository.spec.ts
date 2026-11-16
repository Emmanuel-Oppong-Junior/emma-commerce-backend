import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { ProductsRepository } from './products.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Category, Prisma, Product, SubCategory, Tag } from '@prisma/client';

const mockProduct = {
  id: 'prod1',
  name: 'T-Shirt',
  price: new Prisma.Decimal(50),
  description: null,
  sku: 'TSHIRT001',
  quantity: 10,
  images: [],
  isActive: true,
  categoryId: 'cat1',
  subcategoryId: null,
  brandId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Product;

const mockPrismaProduct = {
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
};

const mockPrismaCategory = { findUnique: jest.fn() };
const mockPrismaSubCategory = { findUnique: jest.fn() };
const mockPrismaTag = { findUnique: jest.fn() };
const mockPrismaCartItem = { count: jest.fn() };
const mockPrismaOrderItem = { count: jest.fn() };

const mockPrisma = {
  product: mockPrismaProduct,
  category: mockPrismaCategory,
  subCategory: mockPrismaSubCategory,
  tag: mockPrismaTag,
  cartItem: mockPrismaCartItem,
  orderItem: mockPrismaOrderItem,
};

describe('ProductsRepository', () => {
  let repository: ProductsRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductsRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<ProductsRepository>(ProductsRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a product', async () => {
      mockPrismaProduct.create.mockResolvedValue(mockProduct);

      const result = await repository.create({ name: 'T-Shirt' } as any);

      expect(result).toEqual(mockProduct);
    });

    it('should create a product with include', async () => {
      mockPrismaProduct.create.mockResolvedValue(mockProduct);

      const result = await repository.create({ name: 'T-Shirt' } as any, { category: true });

      expect(result).toEqual(mockProduct);
      expect(mockPrismaProduct.create).toHaveBeenCalledWith(expect.objectContaining({ include: { category: true } }));
    });

    it('should throw ConflictException on P2002 (duplicate SKU)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaProduct.create.mockRejectedValue(prismaError);

      await expect(repository.create({ name: 'Dup' } as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaProduct.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ name: 'X' } as any)).rejects.toThrow('DB error');
    });
  });

  describe('update', () => {
    it('should update a product', async () => {
      const updated = { ...mockProduct, name: 'Updated Shirt' };
      mockPrismaProduct.update.mockResolvedValue(updated);

      const result = await repository.update('prod1', { name: 'Updated Shirt' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaProduct.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaProduct.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('prod1', {})).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a product', async () => {
      mockPrismaProduct.delete.mockResolvedValue(mockProduct);

      const result = await repository.delete('prod1');

      expect(result).toEqual(mockProduct);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaProduct.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaProduct.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('prod1')).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a product by ID', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(mockProduct);

      const result = await repository.findById('prod1');

      expect(result).toEqual(mockProduct);
    });

    it('should apply select when provided', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue({ id: 'prod1', name: 'T-Shirt' });

      const result = await repository.findById('prod1', { name: true });

      expect(result).toEqual({ id: 'prod1', name: 'T-Shirt' });
      expect(mockPrismaProduct.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ id: true, name: true }) }),
      );
    });

    it('should return null if not found', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findFirst', () => {
    it('should find first product matching condition', async () => {
      mockPrismaProduct.findFirst.mockResolvedValue(mockProduct);

      const result = await repository.findFirst({ sku: 'TSHIRT001' });

      expect(result).toEqual(mockProduct);
    });

    it('should return null if none match', async () => {
      mockPrismaProduct.findFirst.mockResolvedValue(null);

      const result = await repository.findFirst({ sku: 'NONEXISTENT' });

      expect(result).toBeNull();
    });
  });

  describe('findMany', () => {
    it('should return products with pagination options', async () => {
      mockPrismaProduct.findMany.mockResolvedValue([mockProduct]);

      const result = await repository.findMany({ take: 10, skip: 0 }, { isActive: true }, { createdAt: 'desc' });

      expect(result).toEqual([mockProduct]);
      expect(mockPrismaProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 10, skip: 0, where: { isActive: true }, orderBy: { createdAt: 'desc' } }),
      );
    });

    it('should apply select when provided', async () => {
      mockPrismaProduct.findMany.mockResolvedValue([{ id: 'prod1', name: 'T-Shirt' }]);

      const result = await repository.findMany({}, {}, { createdAt: 'desc' }, { name: true });

      expect(mockPrismaProduct.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ select: expect.objectContaining({ id: true, name: true }) }),
      );
      expect(result).toEqual([{ id: 'prod1', name: 'T-Shirt' }]);
    });
  });

  describe('count', () => {
    it('should count products matching the condition', async () => {
      mockPrismaProduct.count.mockResolvedValue(5);

      const result = await repository.count({ isActive: true });

      expect(result).toBe(5);
    });
  });

  describe('updateTags', () => {
    it('should connect a tag to a product', async () => {
      const updated = { ...mockProduct, tags: [{ id: 'tag1', name: 'Sale' }] };
      mockPrismaProduct.update.mockResolvedValue(updated);

      const result = await repository.updateTags('prod1', 'connect', 'tag1');

      expect(result).toEqual(updated);
      expect(mockPrismaProduct.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prod1' },
          data: { tags: { connect: { id: 'tag1' } } },
        }),
      );
    });

    it('should disconnect a tag from a product', async () => {
      mockPrismaProduct.update.mockResolvedValue(mockProduct);

      await repository.updateTags('prod1', 'disconnect', 'tag1');

      expect(mockPrismaProduct.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { tags: { disconnect: { id: 'tag1' } } },
        }),
      );
    });
  });

  describe('findCategoryById', () => {
    it('should find a category by ID', async () => {
      const mockCategory = { id: 'cat1', name: 'Clothing' } as unknown as Category;
      mockPrismaCategory.findUnique.mockResolvedValue(mockCategory);

      const result = await repository.findCategoryById('cat1');

      expect(result).toEqual(mockCategory);
    });

    it('should return null if not found', async () => {
      mockPrismaCategory.findUnique.mockResolvedValue(null);

      expect(await repository.findCategoryById('nonexistent')).toBeNull();
    });
  });

  describe('findSubCategoryById', () => {
    it('should find a sub-category by ID', async () => {
      const mockSubCat = { id: 'sub1', name: 'T-Shirts' } as unknown as SubCategory;
      mockPrismaSubCategory.findUnique.mockResolvedValue(mockSubCat);

      const result = await repository.findSubCategoryById('sub1');

      expect(result).toEqual(mockSubCat);
    });
  });

  describe('findTagById', () => {
    it('should find a tag by ID', async () => {
      const mockTag = { id: 'tag1', name: 'Sale' } as unknown as Tag;
      mockPrismaTag.findUnique.mockResolvedValue(mockTag);

      const result = await repository.findTagById('tag1');

      expect(result).toEqual(mockTag);
    });
  });

  describe('countCartItems', () => {
    it('should count cart items for a product', async () => {
      mockPrismaCartItem.count.mockResolvedValue(3);

      const result = await repository.countCartItems('prod1');

      expect(result).toBe(3);
      expect(mockPrismaCartItem.count).toHaveBeenCalledWith({ where: { productId: 'prod1' } });
    });
  });

  describe('countOrderItems', () => {
    it('should count order items for a product', async () => {
      mockPrismaOrderItem.count.mockResolvedValue(7);

      const result = await repository.countOrderItems('prod1');

      expect(result).toBe(7);
      expect(mockPrismaOrderItem.count).toHaveBeenCalledWith({ where: { productId: 'prod1' } });
    });
  });
});
