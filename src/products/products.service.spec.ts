import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { ConflictException, NotFoundException } from '@nestjs/common';

const mockProductsRepository = {
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findById: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  count: jest.fn(),
  updateTags: jest.fn(),
  findCategoryById: jest.fn(),
  findSubCategoryById: jest.fn(),
  findTagById: jest.fn(),
  countCartItems: jest.fn(),
  countOrderItems: jest.fn(),
};

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ProductsService, { provide: ProductsRepository, useValue: mockProductsRepository }],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get<ProductsRepository>(ProductsRepository) as jest.Mocked<ProductsRepository>;
    jest.clearAllMocks();
  });

  describe('create', () => {
    const input = {
      name: 'T-Shirt',
      price: '19.99',
      quantity: 100,
      categoryId: 'cat1',
      subcategoryId: 'sub1',
      sku: 'TSHIRT001',
      isActive: true,
      images: ['https://example.com/tshirt.jpg'],
    };

    it('should create a product successfully', async () => {
      const product = { id: 'prod1', ...input, createdAt: new Date(), updatedAt: new Date() };
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.create.mockResolvedValue(product);

      const result = await service.create(input);

      expect(productsRepository.findCategoryById).toHaveBeenCalledWith('cat1');
      expect(productsRepository.findSubCategoryById).toHaveBeenCalledWith('sub1');
      expect(productsRepository.create).toHaveBeenCalledWith(input, { category: true, subcategory: true });
      expect(result).toEqual(product);
    });

    it('should throw NotFoundException if category does not exist', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue(null);

      await expect(service.create(input)).rejects.toThrow(new NotFoundException('Category ID "cat1" not found'));
    });

    it('should throw ConflictException if SKU is already in use', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue({ id: 'prod2', sku: 'TSHIRT001' });

      await expect(service.create(input)).rejects.toThrow(new ConflictException('SKU "TSHIRT001" is already in use'));
    });
  });

  describe('findAll', () => {
    const paginate: PaginationArgs = { first: 2, after: undefined };
    const filter: ProductFilterArgs = { categoryId: 'cat1', isActive: true };
    const products = [
      { id: 'prod1', name: 'T-Shirt', price: 19.99, categoryId: 'cat1', isActive: true, createdAt: new Date(), updatedAt: new Date(), images: [] },
      { id: 'prod2', name: 'Jeans', price: 49.99, categoryId: 'cat1', isActive: true, createdAt: new Date(), updatedAt: new Date(), images: [] },
    ];

    it('should return paginated products with filters', async () => {
      mockProductsRepository.findMany.mockResolvedValue(products);
      mockProductsRepository.count.mockResolvedValue(3);

      const result = await service.findAll(paginate, filter);

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { take: 2, skip: 0, cursor: undefined },
        { categoryId: 'cat1', isActive: true },
        undefined,
      );
      expect(productsRepository.count).toHaveBeenCalledWith({ categoryId: 'cat1', isActive: true });
      expect(result).toEqual({
        edges: products.map((p) => ({ cursor: p.id, node: p })),
        pageInfo: { pageSize: 2, hasPreviousPage: false, hasNextPage: true },
      });
    });

    it('should handle search filter across name and description', async () => {
      const searchFilter: ProductFilterArgs = { search: 'shirt' };
      mockProductsRepository.findMany.mockResolvedValue([products[0]]);
      mockProductsRepository.count.mockResolvedValue(1);

      await service.findAll(paginate, searchFilter);

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        expect.any(Object),
        {
          OR: [
            { name: { contains: 'shirt', mode: 'insensitive' } },
            { description: { contains: 'shirt', mode: 'insensitive' } },
            { tags: { some: { name: { contains: 'shirt', mode: 'insensitive' } } } },
          ],
        },
        undefined,
      );
    });

    it('should select only requested fields when requestedField is provided', async () => {
      mockProductsRepository.findMany.mockResolvedValue(products);
      mockProductsRepository.count.mockResolvedValue(3);

      await service.findAll(paginate, filter, { id: true, name: true });

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { take: 2, skip: 0, cursor: undefined },
        { categoryId: 'cat1', isActive: true },
        { id: true, name: true },
      );
    });

    it('should respect pagination with after cursor', async () => {
      const paginateWithCursor: PaginationArgs = { first: 1, after: 'prod1' };
      mockProductsRepository.findMany.mockResolvedValue([products[1]]);
      mockProductsRepository.count.mockResolvedValue(2);

      await service.findAll(paginateWithCursor, {});

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 1, skip: 1, cursor: { id: 'prod1' } }),
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('findOne', () => {
    it('should return a product by ID', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', price: 19.99, categoryId: 'cat1', isActive: true, createdAt: new Date(), updatedAt: new Date(), images: [] };
      mockProductsRepository.findById.mockResolvedValue(product);

      const result = await service.findOne('prod1');

      expect(productsRepository.findById).toHaveBeenCalledWith('prod1', {});
      expect(result).toEqual(product);
    });

    it('should return null if product not found', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      const result = await service.findOne('prod999');

      expect(result).toBeNull();
    });
  });

  describe('update', () => {
    const updateInput = { name: 'Updated T-Shirt', price: '29.99', id: 'prod1' };

    it('should update a product successfully', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', categoryId: 'cat1', isActive: true, createdAt: new Date(), updatedAt: new Date(), images: [] };
      const updatedProduct = { ...product, ...updateInput };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.update.mockResolvedValue(updatedProduct);

      const result = await service.update('prod1', updateInput);

      expect(productsRepository.update).toHaveBeenCalledWith('prod1', updateInput, { category: true, subcategory: true });
      expect(result).toEqual(updatedProduct);
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.update('prod999', updateInput)).rejects.toThrow(new NotFoundException('Product not found'));
    });

    it('should throw ConflictException if SKU conflicts', async () => {
      const skuInput: UpdateProductInput = { sku: 'TSHIRT002' };
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue({ id: 'prod2', sku: 'TSHIRT002' });

      await expect(service.update('prod1', skuInput)).rejects.toThrow(
        new ConflictException('SKU "TSHIRT002" is already in use by another product'),
      );
    });
  });

  describe('remove', () => {
    it('should remove a product successfully', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', isActive: true, categoryId: 'cat1', createdAt: new Date(), updatedAt: new Date(), images: [] };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.countCartItems.mockResolvedValue(0);
      mockProductsRepository.countOrderItems.mockResolvedValue(0);
      mockProductsRepository.delete.mockResolvedValue(product);

      const result = await service.remove('prod1');

      expect(productsRepository.delete).toHaveBeenCalledWith('prod1');
      expect(result).toEqual(product);
    });

    it('should throw ConflictException if product has dependencies', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1' });
      mockProductsRepository.countCartItems.mockResolvedValue(1);

      await expect(service.remove('prod1')).rejects.toThrow(
        new ConflictException('Cannot delete product referenced in active carts or orders'),
      );
    });
  });

  describe('archiveProduct', () => {
    it('should archive a product successfully', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', isActive: true, categoryId: 'cat1', createdAt: new Date(), updatedAt: new Date(), images: [] };
      const archivedProduct = { ...product, isActive: false };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.update.mockResolvedValue(archivedProduct);

      const result = await service.archiveProduct('prod1');

      expect(productsRepository.update).toHaveBeenCalledWith('prod1', { isActive: false });
      expect(result).toEqual(archivedProduct);
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.archiveProduct('prod999')).rejects.toThrow(new NotFoundException('Product not found'));
    });
  });

  describe('restoreProduct', () => {
    it('should restore a product successfully', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', isActive: false, categoryId: 'cat1', createdAt: new Date(), updatedAt: new Date(), images: [] };
      const restoredProduct = { ...product, isActive: true };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.update.mockResolvedValue(restoredProduct);

      const result = await service.restoreProduct('prod1');

      expect(productsRepository.update).toHaveBeenCalledWith('prod1', { isActive: true });
      expect(result).toEqual(restoredProduct);
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.restoreProduct('prod999')).rejects.toThrow(new NotFoundException('Product not found'));
    });
  });
});
