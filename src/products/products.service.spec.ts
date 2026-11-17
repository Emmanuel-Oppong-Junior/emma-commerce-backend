import { Test, TestingModule } from '@nestjs/testing';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { TaxService } from '../tax/tax.service';
import { CreateProductInput } from './dto/create-product.input';
import { ProductSortField } from './enums/product-sort-field.enum';
import { SortOrder } from '../commons/enums/sort-order.enum';
import { UpdateProductInput } from './dto/update-product.input';
import { ProductFilterArgs } from './dto/product-filter.args';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductStatusEnum } from './enums/product.enum';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';

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

const mockTaxService = {
  getTotalActiveRate: jest.fn(),
};

const mockAuditService = createAuditServiceMock();

describe('ProductsService', () => {
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: mockProductsRepository },
        { provide: TaxService, useValue: mockTaxService },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get<ProductsRepository>(ProductsRepository) as jest.Mocked<ProductsRepository>;
    jest.clearAllMocks();
  });

  describe('create', () => {
    const input: CreateProductInput = {
      name: 'T-Shirt',
      basePrice: '19.99',
      isTaxable: false,
      quantity: 100,
      categoryId: 'cat1',
      subcategoryId: 'sub1',
      sku: 'TSHIRT001',
      isActive: true,
      images: ['https://example.com/tshirt.jpg'],
    };

    it('should create a product successfully', async () => {
      const product = { id: 'prod1', ...input, price: '19.99', createdAt: new Date(), updatedAt: new Date() };
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.create.mockResolvedValue(product);

      const result = await service.create(input, 'admin1');

      expect(productsRepository.findCategoryById).toHaveBeenCalledWith('cat1');
      expect(productsRepository.findSubCategoryById).toHaveBeenCalledWith('sub1');
      expect(productsRepository.create).toHaveBeenCalledWith(
        { ...input, price: '19.99' },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
      expect(mockTaxService.getTotalActiveRate).not.toHaveBeenCalled();
      expect(result).toEqual(product);
    });

    it('should set price to basePrice plus the total active tax rate when taxable', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockTaxService.getTotalActiveRate.mockResolvedValue(0.15);

      await service.create({ ...input, basePrice: '100.00', isTaxable: true }, 'admin1');

      expect(productsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ basePrice: '100.00', price: '115.00', isTaxable: true }),
        { category: true, subcategory: true },
        AUDIT_TX,
      );
    });

    it('should throw NotFoundException if category does not exist', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue(null);

      await expect(service.create(input, 'admin1')).rejects.toThrow(
        new NotFoundException('Category ID "cat1" not found'),
      );
    });

    it('should throw ConflictException if SKU is already in use', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue({ id: 'prod2', sku: 'TSHIRT001' });

      await expect(service.create(input, 'admin1')).rejects.toThrow(
        new ConflictException('SKU "TSHIRT001" is already in use'),
      );
    });
  });

  describe('findAll', () => {
    const paginate: PaginationArgs = { first: 2, after: undefined };
    const filter: ProductFilterArgs = { categoryId: 'cat1', isActive: true };
    const products = [
      {
        id: 'prod1',
        name: 'T-Shirt',
        price: 19.99,
        categoryId: 'cat1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      },
      {
        id: 'prod2',
        name: 'Jeans',
        price: 49.99,
        categoryId: 'cat1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      },
    ];

    it('should return paginated products with filters', async () => {
      const extraProduct = {
        id: 'prod3',
        name: 'Hoodie',
        price: 59.99,
        categoryId: 'cat1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      // Return take+1 items to signal hasNextPage=true
      mockProductsRepository.findMany.mockResolvedValue([...products, extraProduct]);
      mockProductsRepository.count.mockResolvedValue(3);

      const result = await service.findAll(paginate, filter);

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { take: 3, skip: 0, cursor: undefined },
        { categoryId: 'cat1', isActive: true },
        { createdAt: 'desc' },
        undefined,
      );
      expect(productsRepository.count).toHaveBeenCalledWith({ categoryId: 'cat1', isActive: true });
      expect(result).toEqual({
        edges: products.map((p) => ({ cursor: p.id, node: p })),
        pageInfo: { pageSize: 2, hasPreviousPage: false, hasNextPage: true, totalCount: 3 },
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
            { name: { search: 'shirt' } },
            { description: { search: 'shirt' } },
            { tags: { some: { name: { contains: 'shirt', mode: 'insensitive' } } } },
          ],
        },
        { createdAt: 'desc' },
        undefined,
      );
    });

    it('should select only requested fields when requestedField is provided', async () => {
      mockProductsRepository.findMany.mockResolvedValue(products);

      await service.findAll(paginate, filter, {}, { id: true, name: true });

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { take: 3, skip: 0, cursor: undefined },
        { categoryId: 'cat1', isActive: true },
        { createdAt: 'desc' },
        { id: true, name: true },
      );
    });

    it('should order by the requested sort field and direction', async () => {
      mockProductsRepository.findMany.mockResolvedValue(products);

      await service.findAll(paginate, filter, { sortBy: ProductSortField.PRICE, sortOrder: SortOrder.ASC });

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        expect.any(Object),
        expect.any(Object),
        { price: 'asc' },
        undefined,
      );
    });

    it('should respect pagination with after cursor', async () => {
      const paginateWithCursor: PaginationArgs = { first: 1, after: 'prod1' };
      mockProductsRepository.findMany.mockResolvedValue([products[1]]);

      await service.findAll(paginateWithCursor, {});

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 2, skip: 1, cursor: { id: 'prod1' } }),
        expect.any(Object),
        expect.any(Object),
        undefined,
      );
    });
  });

  describe('public visibility', () => {
    const published = { isActive: true, status: 'PUBLISHED' };

    it('forces active and PUBLISHED on the public list, overriding the client filter', async () => {
      mockProductsRepository.findMany.mockResolvedValue([]);
      mockProductsRepository.count.mockResolvedValue(0);

      await service.findAllPublished(
        { first: 5 },
        { categoryId: 'cat1', isActive: false, status: ProductStatusEnum.DRAFT },
      );

      const where = { categoryId: 'cat1', ...published };
      expect(productsRepository.findMany).toHaveBeenCalledWith(
        expect.any(Object),
        where,
        expect.any(Object),
        undefined,
      );
      expect(productsRepository.count).toHaveBeenCalledWith(where);
    });

    it('lets the admin list filter by any status and inactive products', async () => {
      mockProductsRepository.findMany.mockResolvedValue([]);
      mockProductsRepository.count.mockResolvedValue(0);

      await service.findAll({ first: 5 }, { isActive: false, status: ProductStatusEnum.ARCHIVED });

      expect(productsRepository.count).toHaveBeenCalledWith({ isActive: false, status: 'ARCHIVED' });
    });

    it('looks up a single public product only among published ones', async () => {
      mockProductsRepository.findFirst.mockResolvedValue(null);

      const result = await service.findPublishedById('draft-1', { name: true });

      expect(productsRepository.findFirst).toHaveBeenCalledWith({ id: 'draft-1', ...published }, { name: true });
      expect(result).toBeNull();
    });

    it('returns the newest published products of a parent, capped by first', async () => {
      mockProductsRepository.findMany.mockResolvedValue([]);

      await service.findPublishedIn({ brandId: 'brand-1' }, 20);

      expect(productsRepository.findMany).toHaveBeenCalledWith(
        { take: 20 },
        { brandId: 'brand-1', ...published },
        { createdAt: 'desc' },
      );
    });

    it.each([0, 101, 2.5])('rejects first = %p', async (first) => {
      await expect(service.findPublishedIn({ categoryId: 'cat1' }, first)).rejects.toThrow(BadRequestException);
      expect(productsRepository.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a product by ID', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        price: 19.99,
        categoryId: 'cat1',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
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
    const updateInput: UpdateProductInput = { name: 'Updated T-Shirt', basePrice: '29.99' };

    it('should update a product successfully', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        categoryId: 'cat1',
        basePrice: '19.99',
        isTaxable: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      const updatedProduct = { ...product, ...updateInput, price: '29.99' };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.update.mockResolvedValue(updatedProduct);

      const result = await service.update('prod1', updateInput, 'admin1');

      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        { name: 'Updated T-Shirt', basePrice: '29.99', price: '29.99' },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
      expect(result).toEqual(updatedProduct);
    });

    it('should recompute price from the existing basePrice when only isTaxable changes', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', basePrice: '100.00', isTaxable: false });
      mockTaxService.getTotalActiveRate.mockResolvedValue(0.2);

      await service.update('prod1', { isTaxable: true }, 'admin1');

      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        { isTaxable: true, price: '120.00' },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.update('prod999', updateInput, 'admin1')).rejects.toThrow(
        new NotFoundException('Product not found'),
      );
    });

    it('should throw ConflictException if SKU conflicts', async () => {
      const skuInput: UpdateProductInput = { sku: 'TSHIRT002' };
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', categoryId: 'cat1' });
      mockProductsRepository.findFirst.mockResolvedValue({ id: 'prod2', sku: 'TSHIRT002' });

      await expect(service.update('prod1', skuInput, 'admin1')).rejects.toThrow(
        new ConflictException('SKU "TSHIRT002" is already in use by another product'),
      );
    });
  });

  describe('remove', () => {
    it('should remove a product successfully', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        isActive: true,
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.countCartItems.mockResolvedValue(0);
      mockProductsRepository.countOrderItems.mockResolvedValue(0);
      mockProductsRepository.delete.mockResolvedValue(product);

      const result = await service.remove('prod1', 'admin1');

      expect(productsRepository.delete).toHaveBeenCalledWith('prod1', AUDIT_TX);
      expect(result).toEqual(product);
    });

    it('should throw ConflictException if product has dependencies', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1' });
      mockProductsRepository.countCartItems.mockResolvedValue(1);

      await expect(service.remove('prod1', 'admin1')).rejects.toThrow(
        new ConflictException('Cannot delete product referenced in active carts or orders'),
      );
    });
  });

  describe('archiveProduct', () => {
    it('should archive a product successfully', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        isActive: true,
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      const archivedProduct = { ...product, isActive: false };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.update.mockResolvedValue(archivedProduct);

      const result = await service.archiveProduct('prod1', 'admin1');

      expect(productsRepository.update).toHaveBeenCalledWith('prod1', { isActive: false }, undefined, AUDIT_TX);
      expect(result).toEqual(archivedProduct);
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.archiveProduct('prod999', 'admin1')).rejects.toThrow(
        new NotFoundException('Product not found'),
      );
    });
  });

  describe('restoreProduct', () => {
    it('should restore a product successfully', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        isActive: false,
        categoryId: 'cat1',
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      const restoredProduct = { ...product, isActive: true };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.update.mockResolvedValue(restoredProduct);

      const result = await service.restoreProduct('prod1', 'admin1');

      expect(productsRepository.update).toHaveBeenCalledWith('prod1', { isActive: true }, undefined, AUDIT_TX);
      expect(result).toEqual(restoredProduct);
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.restoreProduct('prod999', 'admin1')).rejects.toThrow(
        new NotFoundException('Product not found'),
      );
    });
  });

  describe('audit trail', () => {
    const existing = {
      id: 'prod1',
      name: 'T-Shirt',
      sku: 'TSHIRT001',
      basePrice: '100.00',
      price: '100.00',
      isTaxable: false,
      isActive: true,
      status: 'PUBLISHED',
      categoryId: null,
    };

    beforeEach(() => {
      mockProductsRepository.findById.mockResolvedValue(existing);
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.findTagById.mockResolvedValue({ id: 'tag1' });
      mockProductsRepository.countCartItems.mockResolvedValue(0);
      mockProductsRepository.countOrderItems.mockResolvedValue(0);
      mockProductsRepository.create.mockImplementation(async (data) => ({ id: 'prod2', ...data }));
      mockProductsRepository.update.mockImplementation(async (_id, data) => ({ ...existing, ...data }));
      mockProductsRepository.delete.mockResolvedValue(existing);
      mockProductsRepository.updateTags.mockResolvedValue(existing);
      mockTaxService.getTotalActiveRate.mockResolvedValue(0.2);
    });

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'create',
        () =>
          service.create({ name: 'Mug', basePrice: '10.00', isTaxable: true, quantity: 1, isActive: true }, 'admin1'),
        {
          entityId: 'prod2',
          action: 'CREATE',
          details: {
            after: expect.objectContaining({ name: 'Mug', basePrice: '10.00', price: '12.00', isTaxable: true }),
          },
        },
      ],
      [
        'update (price)',
        () => service.update('prod1', { basePrice: '150.00', isTaxable: true }, 'admin1'),
        {
          entityId: 'prod1',
          action: 'UPDATE',
          details: {
            changes: {
              basePrice: { from: '100.00', to: '150.00' },
              price: { from: '100.00', to: '180.00' },
              isTaxable: { from: false, to: true },
            },
          },
        },
      ],
      [
        'remove',
        () => service.remove('prod1', 'admin1'),
        {
          entityId: 'prod1',
          action: 'DELETE',
          details: { before: expect.objectContaining({ name: 'T-Shirt', price: '100.00', sku: 'TSHIRT001' }) },
        },
      ],
      [
        'archiveProduct',
        () => service.archiveProduct('prod1', 'admin1'),
        { entityId: 'prod1', action: 'ARCHIVE', details: { changes: { isActive: { from: true, to: false } } } },
      ],
      [
        'restoreProduct',
        () => service.restoreProduct('prod1', 'admin1'),
        { entityId: 'prod1', action: 'RESTORE', details: { changes: {} } },
      ],
      [
        'addTagToProduct',
        () => service.addTagToProduct('prod1', 'tag1', 'admin1'),
        { entityId: 'prod1', action: 'UPDATE', details: { tags: { connect: 'tag1' } } },
      ],
      [
        'removeTagFromProduct',
        () => service.removeTagFromProduct('prod1', 'tag1', 'admin1'),
        { entityId: 'prod1', action: 'UPDATE', details: { tags: { disconnect: 'tag1' } } },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith({ entity: 'Product', userId: 'admin1', ...expected }, AUDIT_TX);
    });

    it('writes nothing to the audit log when validation rejects the change', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.update('prod999', { name: 'x' }, 'admin1')).rejects.toThrow(NotFoundException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });
});
