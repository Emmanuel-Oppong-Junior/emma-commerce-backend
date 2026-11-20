import { Test, TestingModule } from '@nestjs/testing';
import { ProductsResolver } from './products.resolver';
import { ProductsService } from './products.service';
import { VariantsLoader } from './loaders/variants.loader';
import { VariantSummaryLoader } from './loaders/variant-summary.loader';
import { ReviewsLoader } from './loaders/reviews.loader';
import { ProductTypesLoader } from '../product-types/product-types.loader';
import { CreateProductInput } from './dto/create-product.input';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { Product } from './entities/product.entity';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { Prisma } from '../generated/prisma/client';
import { Decimal } from '@prisma/client/runtime/client';

const mockProductsService = {
  create: jest.fn(),
  findAll: jest.fn(),
  findOne: jest.fn(),
  findAllPublished: jest.fn(),
  findPublishedById: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  archiveProduct: jest.fn(),
  restoreProduct: jest.fn(),
};
const mockVariantSummaryLoaderFn = jest.fn();
const mockVariantSummaryLoader = { loader: { load: mockVariantSummaryLoaderFn } };
const mockVariantsLoader = { loader: { load: jest.fn().mockResolvedValue([]) } };
const mockReviewsLoader = { loader: { load: jest.fn().mockResolvedValue([]) } };
const mockProduct = {
  id: 'prod1',
  name: 'T-Shirt',
  categoryId: 'cat1',
  isActive: true,
  images: [],
};
jest.mock('../commons/useful-functions', () => ({
  extractRequestedFieldsFromQuery: jest.fn().mockReturnValue({ id: true }),
  extractFieldsFromInfo: jest.fn().mockReturnValue({ id: true }),
}));

describe('ProductsResolver', () => {
  let resolver: ProductsResolver;
  let service: ProductsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsResolver,
        { provide: ProductsService, useValue: mockProductsService },
        { provide: VariantSummaryLoader, useValue: mockVariantSummaryLoader },
        { provide: VariantsLoader, useValue: mockVariantsLoader },
        { provide: ReviewsLoader, useValue: mockReviewsLoader },
        { provide: ProductTypesLoader, useValue: { loader: { load: jest.fn() } } },
      ],
    }).compile();

    resolver = module.get<ProductsResolver>(ProductsResolver);
    service = module.get<ProductsService>(ProductsService);
    jest.clearAllMocks();
  });

  describe('createProduct', () => {
    it('should create a product', async () => {
      const input: CreateProductInput = {
        name: 'T-Shirt',
        variants: [{ basePrice: new Decimal('19.99'), quantity: 100 }],
        isTaxable: false,
        categoryId: 'cat1',
        isActive: true,
      };
      const product: Product = { id: 'prod1', ...input, images: [] } as unknown as Product;
      mockProductsService.create.mockResolvedValue(product);

      const result = await resolver.createProduct('admin1', input);

      expect(service.create).toHaveBeenCalledWith(input, 'admin1');
      expect(result).toEqual(product);
    });
  });

  describe('updateProduct', () => {
    it('should update a product', async () => {
      const input: UpdateProductInput = {
        name: 'Updated T-Shirt',
        isTaxable: true,
      };
      const product: Product = {
        ...mockProduct,
        name: 'Updated T-Shirt',
        isTaxable: true,
      } as unknown as Product;
      mockProductsService.update.mockResolvedValue(product);

      const result = await resolver.updateProduct('admin1', 'prod1', input);

      expect(service.update).toHaveBeenCalledWith('prod1', input, 'admin1');
      expect(result).toEqual(product);
    });
  });

  describe('removeProduct', () => {
    it('should remove a product', async () => {
      mockProductsService.remove.mockResolvedValue(mockProduct);
      const result = await resolver.permanentlyDeleteProduct('admin1', 'prod1');
      expect(service.remove).toHaveBeenCalledWith('prod1', 'admin1');
      expect(result).toEqual(mockProduct);
    });
  });

  describe('archiveProduct', () => {
    it('should archive a product', async () => {
      const product: Product = { ...mockProduct, isActive: false } as unknown as Product;
      mockProductsService.archiveProduct.mockResolvedValue(product);
      const result = await resolver.archiveProduct('admin1', 'prod1');
      expect(service.archiveProduct).toHaveBeenCalledWith('prod1', 'admin1');
      expect(result).toEqual(product);
    });
  });

  describe('restoreProduct', () => {
    it('should restore a product', async () => {
      mockProductsService.restoreProduct.mockResolvedValue(mockProduct);
      const result = await resolver.restoreProduct('admin1', 'prod1');
      expect(service.restoreProduct).toHaveBeenCalledWith('prod1', 'admin1');
      expect(result).toEqual(mockProduct);
    });
  });
  describe('findAll', () => {
    it('should return paginated products', async () => {
      const paginate: PaginationArgs = { first: 2 };
      const filter: ProductFilterArgs = { categoryId: 'cat1' };
      const response = {
        edges: [
          {
            cursor: 'prod1',
            node: {
              ...mockProduct,
              createdAt: new Date(),
              updatedAt: new Date(),
              images: [],
            },
          },
        ],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, pageSize: 2 },
      };
      mockProductsService.findAllPublished.mockResolvedValue(response);

      const result = await resolver.findAll(paginate, filter);

      expect(service.findAllPublished).toHaveBeenCalledWith(paginate, filter, {}, { id: true });
      expect(service.findAll).not.toHaveBeenCalled();
      expect(result).toEqual(response);
    });

    it('should use defaults if paginate is omitted', async () => {
      const response = {
        edges: [],
        pageInfo: { hasNextPage: false, hasPreviousPage: false, pageSize: 10 },
      };
      mockProductsService.findAllPublished.mockResolvedValue(response);
      await resolver.findAll(undefined, {});
      expect(service.findAllPublished).toHaveBeenCalledWith({ first: 10 }, {}, {}, { id: true });
    });
  });

  describe('adminFindAll', () => {
    it('lists products in any status for admins', async () => {
      const filter: ProductFilterArgs = { isActive: false };
      mockProductsService.findAll.mockResolvedValue({ edges: [], pageInfo: {} });

      await resolver.adminFindAll({ first: 5 }, filter);

      expect(service.findAll).toHaveBeenCalledWith({ first: 5 }, filter, {}, { id: true });
      expect(service.findAllPublished).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a product by ID', async () => {
      mockProductsService.findPublishedById.mockResolvedValue(mockProduct);
      const result = await resolver.findOne('prod1');
      expect(service.findPublishedById).toHaveBeenCalledWith('prod1', { id: true });
      expect(service.findOne).not.toHaveBeenCalled();
      expect(result).toEqual(mockProduct);
    });
  });

  describe('adminFindOne', () => {
    it('returns a product in any status for admins', async () => {
      mockProductsService.findOne.mockResolvedValue(mockProduct);

      await resolver.adminFindOne('prod1');

      expect(service.findOne).toHaveBeenCalledWith('prod1', { id: true });
      expect(service.findPublishedById).not.toHaveBeenCalled();
    });
  });
  describe('variant summary fields', () => {
    const product = mockProduct as unknown as Product;

    it("returns the lowest and highest price of the product's active variants", async () => {
      mockVariantSummaryLoaderFn.mockResolvedValue({
        minPrice: new Prisma.Decimal('19.99'),
        maxPrice: new Prisma.Decimal('24.99'),
        totalStock: 7,
      });

      const result = await resolver.priceRange(product);

      expect(mockVariantSummaryLoaderFn).toHaveBeenCalledWith('prod1');
      expect(result).toEqual({ min: new Prisma.Decimal('19.99'), max: new Prisma.Decimal('24.99') });
    });

    it('returns no price range when no active variant is priced', async () => {
      mockVariantSummaryLoaderFn.mockResolvedValue({ minPrice: null, maxPrice: null, totalStock: 0 });

      await expect(resolver.priceRange(product)).resolves.toBeNull();
    });

    it('sums the stock of the active variants', async () => {
      mockVariantSummaryLoaderFn.mockResolvedValue({ minPrice: null, maxPrice: null, totalStock: 7 });

      await expect(resolver.totalStock(product)).resolves.toBe(7);
      await expect(resolver.inStock(product)).resolves.toBe(true);
    });

    it('is out of stock when no active variant has stock', async () => {
      mockVariantSummaryLoaderFn.mockResolvedValue({ minPrice: null, maxPrice: null, totalStock: 0 });

      await expect(resolver.inStock(product)).resolves.toBe(false);
    });
  });
});
