import { Test, TestingModule } from '@nestjs/testing';
import { Prisma } from '../generated/prisma/client';
import { ProductsService } from './products.service';
import { ProductsRepository } from './products.repository';
import { TaxService } from '../tax/tax.service';
import { CreateProductInput } from './dto/create-product.input';
import { ProductSortField } from './enums/product-sort-field.enum';
import { SortOrder } from '../commons/enums/sort-order.enum';
import { UpdateProductInput } from './dto/update-product.input';
import { PaginationArgs } from '../commons/dto/paginate.args';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductStatusEnum } from './enums/product.enum';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock } from '../../test/helpers/audit.helper';
import { Decimal } from '@prisma/client/runtime/client';
import { ProductTypesRepository } from '../product-types/product-types.repository';
import { VariantService } from '../variant/variant.service';
import { LotsService } from '../inventory/lots/lots.service';
import { SerialUnitsService } from '../inventory/serials/serial-units.service';
import { ProductSearch } from './search/product-search.port';

const mockProductsRepository = {
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  findById: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  findManyByIds: jest.fn(),
  count: jest.fn(),
  updateTags: jest.fn(),
  findCategoryById: jest.fn(),
  findSubCategoryById: jest.fn(),
  findTagById: jest.fn(),
  countCartItems: jest.fn(),
  countOrderItems: jest.fn(),
  repriceVariants: jest.fn(),
};

const mockTaxService = {
  getTotalActiveRate: jest.fn(),
};

const mockAuditService = createAuditServiceMock();
const generalType = { id: 'product_type_general', key: 'general', attributes: [] };
const mockProductTypesRepository = { findById: jest.fn() };
const preparedDefault = [{ data: { optionsKey: '' }, quantity: 100 }];
const mockVariantService = { prepare: jest.fn(), insertPrepared: jest.fn() };
const mockProductSearch = { search: jest.fn() };

describe('ProductsService', () => {
  const mockLotsService = { assertTrackingChange: jest.fn() };
  let service: ProductsService;
  let productsRepository: jest.Mocked<ProductsRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: ProductsRepository, useValue: mockProductsRepository },
        { provide: TaxService, useValue: mockTaxService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: ProductTypesRepository, useValue: mockProductTypesRepository },
        { provide: VariantService, useValue: mockVariantService },
        { provide: LotsService, useValue: mockLotsService },
        { provide: SerialUnitsService, useValue: { assertTrackingChange: jest.fn() } },
        { provide: ProductSearch, useValue: mockProductSearch },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
    productsRepository = module.get<ProductsRepository>(ProductsRepository) as jest.Mocked<ProductsRepository>;
    jest.clearAllMocks();
    mockProductTypesRepository.findById.mockResolvedValue(generalType);
    mockVariantService.prepare.mockResolvedValue(preparedDefault);
  });

  describe('create', () => {
    const variants = [
      { basePrice: new Decimal('19.99'), quantity: 100, sku: 'TSHIRT-M', optionValues: { size: 'M' } },
      { basePrice: new Decimal('21.99'), quantity: 40, sku: 'TSHIRT-L', optionValues: { size: 'L' } },
    ];
    const input: CreateProductInput = {
      name: 'T-Shirt',
      variants,
      isTaxable: false,
      categoryId: 'cat1',
      subcategoryId: 'sub1',
      isActive: true,
      images: ['https://example.com/tshirt.jpg'],
    };

    it('should create a product successfully, without price, stock or SKU on the product row', async () => {
      const product = { id: 'prod1', name: 'T-Shirt', createdAt: new Date(), updatedAt: new Date() };
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.create.mockResolvedValue(product);

      const result = await service.create(input, 'admin1');

      expect(productsRepository.findCategoryById).toHaveBeenCalledWith('cat1');
      expect(productsRepository.findSubCategoryById).toHaveBeenCalledWith('sub1');
      expect(productsRepository.create).toHaveBeenCalledWith(
        {
          name: 'T-Shirt',
          isTaxable: false,
          categoryId: 'cat1',
          subcategoryId: 'sub1',
          isActive: true,
          images: ['https://example.com/tshirt.jpg'],
          productType: { connect: { id: 'product_type_general' } },
          attributes: {},
        },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
      expect(result).toEqual(product);
    });

    it('creates every given variant in the same transaction', async () => {
      const prepared = [
        { data: { optionsKey: 'size=M' }, quantity: 100 },
        { data: { optionsKey: 'size=L' }, quantity: 40 },
      ];
      mockVariantService.prepare.mockResolvedValue(prepared);
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.create.mockResolvedValue({ id: 'prod1' });

      await service.create(input, 'admin1');

      expect(mockVariantService.prepare).toHaveBeenCalledWith({ isTaxable: false, productType: generalType }, variants);
      expect(mockVariantService.insertPrepared).toHaveBeenCalledWith(AUDIT_TX, 'prod1', prepared, 'admin1');
      expect(mockVariantService.prepare.mock.invocationCallOrder[0]).toBeLessThan(
        mockProductsRepository.create.mock.invocationCallOrder[0],
      );
    });

    it('prepares the variants as taxable when the product is, so their prices add tax', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockProductsRepository.create.mockResolvedValue({ id: 'prod1' });

      await service.create({ ...input, isTaxable: true }, 'admin1');

      expect(mockVariantService.prepare).toHaveBeenCalledWith({ isTaxable: true, productType: generalType }, variants);
      expect(productsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ isTaxable: true }),
        { category: true, subcategory: true },
        AUDIT_TX,
      );
    });

    it('writes nothing when a variant is rejected', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue({ id: 'cat1' });
      mockProductsRepository.findSubCategoryById.mockResolvedValue({ id: 'sub1', categoryId: 'cat1' });
      mockVariantService.prepare.mockRejectedValue(new ConflictException('SKU "TSHIRT-M" is already in use'));

      await expect(service.create(input, 'admin1')).rejects.toThrow(ConflictException);
      expect(productsRepository.create).not.toHaveBeenCalled();
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if category does not exist', async () => {
      mockProductsRepository.findCategoryById.mockResolvedValue(null);

      await expect(service.create(input, 'admin1')).rejects.toThrow(
        new NotFoundException('Category ID "cat1" not found'),
      );
    });
  });

  describe('findAll', () => {
    const paginate: PaginationArgs = { first: 2, after: undefined };
    const products = [
      { id: 'prod1', name: 'T-Shirt' },
      { id: 'prod2', name: 'Jeans' },
    ];
    const searchArg = () => mockProductSearch.search.mock.calls[0][0];

    beforeEach(() => {
      mockProductSearch.search.mockResolvedValue({
        items: [
          { id: 'prod2', cursor: 'c2' },
          { id: 'prod1', cursor: 'c1' },
        ],
        hasNextPage: true,
        totalCount: 3,
      });
      mockProductsRepository.findManyByIds.mockResolvedValue(products);
    });

    it('returns the page in the order the search port chose, with its cursors and counts', async () => {
      const result = await service.findAll(paginate, { categoryId: 'cat1' });

      expect(productsRepository.findManyByIds).toHaveBeenCalledWith(['prod2', 'prod1'], undefined);
      expect(result).toEqual({
        edges: [
          { cursor: 'c2', node: products[1] },
          { cursor: 'c1', node: products[0] },
        ],
        pageInfo: { pageSize: 2, hasPreviousPage: false, hasNextPage: true, totalCount: 3 },
      });
    });

    it('drops a product deleted between the search and the load', async () => {
      mockProductsRepository.findManyByIds.mockResolvedValue([products[0]]);

      const result = await service.findAll(paginate, {});

      expect(result.edges).toEqual([{ cursor: 'c1', node: products[0] }]);
    });

    it('loads only the requested fields', async () => {
      await service.findAll(paginate, {}, {}, { id: true, name: true });

      expect(productsRepository.findManyByIds).toHaveBeenCalledWith(['prod2', 'prod1'], { id: true, name: true });
    });

    it('passes every filter to the search, none replacing another', async () => {
      await service.findAll(paginate, {
        search: '  shirt  ',
        priceMin: new Decimal(10),
        priceMax: new Decimal(50),
        inStock: false,
        tagId: 'tag1',
        tagName: 'sale',
        subcategoryId: 'sub1',
        subCategoryName: 'Tees',
        brand: 'Acme',
      });

      expect(searchArg().filters).toEqual(
        expect.objectContaining({
          visibility: 'ADMIN',
          text: 'shirt',
          priceMin: new Decimal(10),
          priceMax: new Decimal(50),
          inStock: false,
          tagId: 'tag1',
          tagName: 'sale',
          subcategoryId: 'sub1',
          subCategoryName: 'Tees',
          brandName: 'Acme',
        }),
      );
    });

    it('orders by the requested sort field and direction', async () => {
      await service.findAll(paginate, {}, { sortBy: ProductSortField.NAME, sortOrder: SortOrder.ASC });

      expect(searchArg().sort).toEqual({ key: 'NAME', direction: 'ASC' });
    });

    it('passes the cursor on and reports a previous page', async () => {
      const result = await service.findAll({ first: 1, after: 'cursor-1' }, {});

      expect(searchArg()).toEqual(expect.objectContaining({ first: 1, after: 'cursor-1' }));
      expect(result.pageInfo.hasPreviousPage).toBe(true);
    });

    it('rejects a priceMin above priceMax before searching', async () => {
      await expect(service.findAll(paginate, { priceMin: new Decimal(60), priceMax: new Decimal(50) })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockProductSearch.search).not.toHaveBeenCalled();
    });
  });

  describe('public visibility', () => {
    const published = { isActive: true, status: 'PUBLISHED' };
    const searchArg = () => mockProductSearch.search.mock.calls[0][0];

    beforeEach(() => {
      mockProductSearch.search.mockResolvedValue({ items: [], hasNextPage: false, totalCount: 0 });
      mockProductsRepository.findManyByIds.mockResolvedValue([]);
    });

    it('forces active and PUBLISHED on the public list, overriding the client filter', async () => {
      await service.findAllPublished(
        { first: 5 },
        { categoryId: 'cat1', isActive: false, status: ProductStatusEnum.DRAFT },
      );

      expect(searchArg().filters).toEqual(expect.objectContaining({ visibility: 'PUBLIC', categoryId: 'cat1' }));
      expect(searchArg().filters).not.toHaveProperty('isActive');
      expect(searchArg().filters).not.toHaveProperty('status');
    });

    it('lets the admin list filter by any status and inactive products', async () => {
      await service.findAll({ first: 5 }, { isActive: false, status: ProductStatusEnum.ARCHIVED });

      expect(searchArg().filters).toEqual(
        expect.objectContaining({ visibility: 'ADMIN', isActive: false, status: 'ARCHIVED' }),
      );
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
    const updateInput: UpdateProductInput = { name: 'Updated T-Shirt', description: 'Soft cotton' };
    const repriceVariants = () => productsRepository.repriceVariants;

    it('should update a product successfully', async () => {
      const product = {
        id: 'prod1',
        name: 'T-Shirt',
        categoryId: 'cat1',
        isTaxable: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        images: [],
      };
      const updatedProduct = { ...product, ...updateInput };
      mockProductsRepository.findById.mockResolvedValue(product);
      mockProductsRepository.update.mockResolvedValue(updatedProduct);

      const result = await service.update('prod1', updateInput, 'admin1');

      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        { name: 'Updated T-Shirt', description: 'Soft cotton' },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
      expect(repriceVariants()).not.toHaveBeenCalled();
      expect(mockTaxService.getTotalActiveRate).not.toHaveBeenCalled();
      expect(result).toEqual(updatedProduct);
    });

    it('checks the lot-tracking switch in the update transaction, only when it changes (P4-C.1)', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: false, trackLots: false });
      mockLotsService.assertTrackingChange.mockClear();

      await service.update('prod1', { trackLots: false }, 'admin1');
      expect(mockLotsService.assertTrackingChange).not.toHaveBeenCalled();

      await service.update('prod1', { trackLots: true }, 'admin1');
      expect(mockLotsService.assertTrackingChange).toHaveBeenCalledWith(AUDIT_TX, 'prod1', true);
    });

    it('writes nothing when the lot-tracking switch is refused', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: false, trackLots: true });
      mockProductsRepository.update.mockClear();
      mockLotsService.assertTrackingChange.mockRejectedValueOnce(new BadRequestException('holds stock'));

      await expect(service.update('prod1', { trackLots: false }, 'admin1')).rejects.toThrow('holds stock');
      expect(productsRepository.update).not.toHaveBeenCalled();
    });

    it('reprices every variant with the total active tax rate when tax is turned on, in the same transaction', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: false });
      mockTaxService.getTotalActiveRate.mockResolvedValue(new Prisma.Decimal('0.2'));

      await service.update('prod1', { isTaxable: true }, 'admin1');

      expect(repriceVariants()).toHaveBeenCalledWith(
        'prod1',
        new Prisma.Decimal('0.2'),
        { source: 'ADMIN_EDIT', actorId: 'admin1', reason: null },
        AUDIT_TX,
      );
      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        { isTaxable: true },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
    });

    it('reprices every variant back to its base price when tax is turned off', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: true });
      mockTaxService.getTotalActiveRate.mockResolvedValue(new Prisma.Decimal('0.15'));

      await service.update('prod1', { isTaxable: false }, 'admin1');

      expect(repriceVariants()).toHaveBeenCalledWith(
        'prod1',
        new Prisma.Decimal(0),
        { source: 'ADMIN_EDIT', actorId: 'admin1', reason: null },
        AUDIT_TX,
      );
    });

    it('records the acting admin and the price change reason on the reprice, never on the product', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: false });
      mockTaxService.getTotalActiveRate.mockResolvedValue(new Prisma.Decimal('0.2'));

      await service.update('prod1', { isTaxable: true, priceChangeReason: 'Now VAT-registered' }, 'admin1');

      expect(repriceVariants()).toHaveBeenCalledTimes(1);
      expect(repriceVariants()).toHaveBeenCalledWith(
        'prod1',
        new Prisma.Decimal('0.2'),
        { source: 'ADMIN_EDIT', actorId: 'admin1', reason: 'Now VAT-registered' },
        AUDIT_TX,
      );
      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        { isTaxable: true },
        { category: true, subcategory: true },
        AUDIT_TX,
      );
    });

    it('does not reprice when isTaxable is sent unchanged', async () => {
      mockProductsRepository.findById.mockResolvedValue({ id: 'prod1', isTaxable: true });

      await service.update('prod1', { isTaxable: true }, 'admin1');

      expect(repriceVariants()).not.toHaveBeenCalled();
      expect(mockTaxService.getTotalActiveRate).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockProductsRepository.findById.mockResolvedValue(null);

      await expect(service.update('prod999', updateInput, 'admin1')).rejects.toThrow(
        new NotFoundException('Product not found'),
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
      mockTaxService.getTotalActiveRate.mockResolvedValue(new Prisma.Decimal('0.2'));
    });

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'create',
        () =>
          service.create(
            {
              name: 'Mug',
              variants: [{ basePrice: new Decimal('10.00'), quantity: 1 }],
              isTaxable: true,
              isActive: true,
            },
            'admin1',
          ),
        {
          entityId: 'prod2',
          action: 'CREATE',
          details: {
            after: expect.objectContaining({ name: 'Mug', isTaxable: true, isActive: true }),
            variants: 1,
          },
        },
      ],
      [
        'update (tax)',
        () => service.update('prod1', { isTaxable: true }, 'admin1'),
        {
          entityId: 'prod1',
          action: 'UPDATE',
          details: {
            changes: {
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
          details: { before: expect.objectContaining({ name: 'T-Shirt', isTaxable: false, status: 'PUBLISHED' }) },
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

  describe('product type and attributes', () => {
    const at = new Date('2026-11-20T00:00:00.000Z');
    const def = (key: string, extra: Record<string, unknown> = {}) => ({
      id: key,
      productTypeId: 'type-phone',
      key,
      label: key,
      dataType: 'TEXT',
      unit: null,
      isRequired: false,
      allowedValues: [],
      isVariantAxis: false,
      isFilterable: false,
      position: 0,
      createdAt: at,
      updatedAt: at,
      ...extra,
    });
    const phoneType = {
      id: 'type-phone',
      key: 'phone',
      attributes: [
        def('warranty', { dataType: 'NUMBER', unit: 'months', isRequired: true }),
        def('colour', { isVariantAxis: true }),
      ],
    };
    const existing = {
      id: 'prod1',
      name: 'Phone',
      productTypeId: 'product_type_general',
      attributes: {},
      isTaxable: false,
    };

    beforeEach(() => {
      mockProductsRepository.findFirst.mockResolvedValue(null);
      mockProductsRepository.findById.mockResolvedValue(existing);
      mockProductsRepository.update.mockImplementation(async (id, data) => ({ ...existing, ...data }));
      mockProductTypesRepository.findById.mockImplementation(async (id: string) =>
        id === 'type-phone' ? phoneType : id === 'product_type_general' ? generalType : null,
      );
      Object.assign(mockProductsRepository, { findVariantOptions: jest.fn(), updateVariantOptions: jest.fn() });
    });

    const base: CreateProductInput = {
      name: 'Phone',
      variants: [{ basePrice: new Decimal('10'), quantity: 1 }],
      isTaxable: false,
      isActive: true,
    };

    it('validates attributes against the chosen type and stores them normalised', async () => {
      mockProductsRepository.create.mockResolvedValue({ id: 'p' });

      await service.create({ ...base, productTypeId: 'type-phone', attributes: { warranty: '12' } }, 'admin1');

      expect(productsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ productType: { connect: { id: 'type-phone' } }, attributes: { warranty: 12 } }),
        expect.anything(),
        AUDIT_TX,
      );
    });

    it('rejects invalid attributes before writing', async () => {
      await expect(
        service.create({ ...base, productTypeId: 'type-phone', attributes: { colour: 'Red' } }, 'admin1'),
      ).rejects.toThrow(
        new BadRequestException(
          'Invalid attributes for product type "phone": colour is a variant option; set it on each variant; warranty is required',
        ),
      );
      expect(productsRepository.create).not.toHaveBeenCalled();
    });

    it('rejects an unknown product type with NOT_FOUND', async () => {
      await expect(service.create({ ...base, productTypeId: 'nope' }, 'admin1')).rejects.toThrow(
        new NotFoundException('Product type "nope" not found'),
      );
    });

    it('changes type only when every variant fits it, re-normalising their options in the same transaction', async () => {
      const findVariantOptions = (mockProductsRepository as unknown as Record<string, jest.Mock>).findVariantOptions;
      findVariantOptions.mockResolvedValue([{ id: 'v1', optionValues: {} }]);

      await service.update('prod1', { productTypeId: 'type-phone', attributes: { warranty: 24 } }, 'admin1');

      expect(
        (mockProductsRepository as unknown as Record<string, jest.Mock>).updateVariantOptions,
      ).toHaveBeenCalledWith({ id: 'v1', optionValues: {}, optionsKey: '' }, AUDIT_TX);
      expect(productsRepository.update).toHaveBeenCalledWith(
        'prod1',
        expect.objectContaining({ productType: { connect: { id: 'type-phone' } }, attributes: { warranty: 24 } }),
        expect.anything(),
        AUDIT_TX,
      );
    });

    it('refuses a type change a variant does not fit', async () => {
      (mockProductsRepository as unknown as Record<string, jest.Mock>).findVariantOptions.mockResolvedValue([
        { id: 'v1', optionValues: { size: 'M' } },
      ]);

      await expect(
        service.update('prod1', { productTypeId: 'type-phone', attributes: { warranty: 24 } }, 'admin1'),
      ).rejects.toThrow(BadRequestException);
      expect(mockAuditService.record).not.toHaveBeenCalled();
    });
  });
});
