import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { DiscountService } from './discount.service';
import { DiscountRepository } from './discount.repository';
import { CreateDiscountInput } from './dto/create-discount.input';
import { UpdateDiscountInput } from './dto/update-discount.input';
import { Discount, Prisma } from '../generated/prisma/client';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DiscountType } from './enums/discount-type.enum';
import { AuditService } from '../commons/audit.service';
import { AUDIT_TX, createAuditServiceMock, withoutUndefined } from '../../test/helpers/audit.helper';
import { Decimal } from '@prisma/client/runtime/client';

const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockDiscountRepository = {
  create: jest.fn(),
  update: jest.fn(),
  findById: jest.fn(),
  findAll: jest.fn(),
  delete: jest.fn(),
  getInvalidIds: jest.fn(),
  findCartById: jest.fn(),
  updateCartItem: jest.fn(),
  findActiveDiscountsFor: jest.fn(),
  addItemsToDiscount: jest.fn(),
  removeItemsFromDiscount: jest.fn(),
};

const mockDiscount: Discount = {
  id: 'discount1',
  name: 'Summer Sale',
  description: '20% off',
  type: DiscountType.PERCENTAGE,
  value: new Prisma.Decimal(20),
  startDate: new Date('2025-06-01'),
  endDate: new Date('2025-06-30'),
  isActive: true,
  minimumPurchase: null,
  createdAt: new Date('2025-05-01'),
  updatedAt: new Date('2025-05-01'),
};

const mockAuditService = createAuditServiceMock();

describe('DiscountService', () => {
  let service: DiscountService;
  let discountRepository: jest.Mocked<DiscountRepository>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscountService,
        { provide: DiscountRepository, useValue: mockDiscountRepository },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: AuditService, useValue: mockAuditService },
      ],
    }).compile();

    service = module.get<DiscountService>(DiscountService);
    discountRepository = module.get<DiscountRepository>(DiscountRepository) as jest.Mocked<DiscountRepository>;
    jest.clearAllMocks();
  });

  describe('createDiscount', () => {
    const input: CreateDiscountInput = {
      name: 'Summer Sale',
      type: DiscountType.PERCENTAGE,
      value: new Decimal('20'),
      startDate: new Date('2025-06-01'),
      endDate: new Date('2025-06-30'),
      isActive: true,
      products: ['product1'],
      variants: [],
      categories: [],
    };

    it('should create a discount successfully', async () => {
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.create.mockResolvedValue(mockDiscount);

      const result = await service.createDiscount(input, 'admin1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: input.name,
          type: input.type,
          value: input.value,
          isActive: true,
          products: { connect: [{ id: 'product1' }] },
        }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
    });

    it('should throw BadRequestException for invalid product IDs', async () => {
      mockDiscountRepository.getInvalidIds.mockResolvedValue(['product1']);

      await expect(service.createDiscount(input, 'admin1')).rejects.toThrow(BadRequestException);
      expect(discountRepository.getInvalidIds).toHaveBeenCalledWith(['product1'], 'product');
    });

    it('should throw BadRequestException for endDate before startDate', async () => {
      const invalidInput = { ...input, endDate: new Date('2025-05-01') };

      await expect(service.createDiscount(invalidInput, 'admin1')).rejects.toThrow('End date must be after start date');
    });
  });

  describe('updateDiscount', () => {
    const input: UpdateDiscountInput = {
      id: 'discount1',
      name: 'Updated Sale',
      isActive: false,
    };

    it('should update a discount successfully', async () => {
      const updated = { ...mockDiscount, name: 'Updated Sale', isActive: false };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.update.mockResolvedValue(updated);

      const result = await service.updateDiscount(input.id, input, 'admin1');

      expect(result).toEqual(updated);
      expect(discountRepository.update).toHaveBeenCalledWith(
        input.id,
        expect.objectContaining({ name: input.name, isActive: false }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.updateDiscount(input.id, input, 'admin1')).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException for empty update', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      await expect(service.updateDiscount(input.id, { id: input.id }, 'admin1')).rejects.toThrow(
        'At least one field must be provided for update',
      );
    });
  });

  describe('findAllDiscounts', () => {
    it('should return all discounts from cache when cached', async () => {
      mockCacheManager.get.mockResolvedValue([mockDiscount]);

      const result = await service.findAllDiscounts();

      expect(result).toEqual([mockDiscount]);
      expect(discountRepository.findAll).not.toHaveBeenCalled();
    });

    it('should fetch from repository on cache miss and populate cache', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findAll.mockResolvedValue([mockDiscount]);

      const result = await service.findAllDiscounts();

      expect(result).toEqual([mockDiscount]);
      expect(discountRepository.findAll).toHaveBeenCalled();
      expect(mockCacheManager.set).toHaveBeenCalledWith('discount:all', [mockDiscount]);
    });
  });

  describe('findOneDiscount', () => {
    it('should return a discount from cache when cached', async () => {
      mockCacheManager.get.mockResolvedValue(mockDiscount);

      const result = await service.findOneDiscount('discount1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.findById).not.toHaveBeenCalled();
    });

    it('should fetch from repository on cache miss', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);

      const result = await service.findOneDiscount('discount1');

      expect(result).toEqual(mockDiscount);
      expect(mockCacheManager.set).toHaveBeenCalledWith('discount:discount1', mockDiscount);
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockCacheManager.get.mockResolvedValue(null);
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.findOneDiscount('discount2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deleteDiscount', () => {
    it('should delete a discount successfully', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.delete.mockResolvedValue(mockDiscount);

      const result = await service.deleteDiscount('discount1', 'admin1');

      expect(result).toEqual(mockDiscount);
      expect(discountRepository.delete).toHaveBeenCalledWith('discount1', AUDIT_TX);
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException for non-existent discount', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.deleteDiscount('discount2', 'admin1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findCandidateDiscounts', () => {
    const now = new Date('2025-06-15');
    const targeting = (discount: Discount, productIds: string[], categoryIds: string[] = []) => ({
      ...discount,
      products: productIds.map((id) => ({ id })),
      categories: categoryIds.map((id) => ({ id })),
    });
    const variant = (id: string, discountId: string | null = null) => ({
      id,
      productId: 'product1',
      categoryId: 'category1',
      discountId,
    });

    it('looks the discounts up for the products, categories and variant discounts at `now`, on the given client', async () => {
      const tx = {} as Prisma.TransactionClient;
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([targeting(mockDiscount, ['product1'])]);

      const result = await service.findCandidateDiscounts(
        [variant('variant1', 'variantSale'), variant('variant2')],
        now,
        tx,
      );

      expect(discountRepository.findActiveDiscountsFor).toHaveBeenCalledWith(
        ['product1'],
        ['category1'],
        ['variantSale'],
        now,
        tx,
      );
      expect(result).toEqual([
        {
          id: 'discount1',
          type: 'PERCENTAGE',
          value: new Prisma.Decimal(20),
          minimumPurchase: null,
          isActive: true,
          startDate: mockDiscount.startDate,
          endDate: mockDiscount.endDate,
          createdAt: mockDiscount.createdAt,
          variantIds: [],
          productIds: ['product1'],
          categoryIds: [],
        },
      ]);
    });

    it("targets a product's or category's discount by id, and a variant's own discount only to that variant", async () => {
      mockDiscountRepository.findActiveDiscountsFor.mockResolvedValue([
        targeting(mockDiscount, [], ['category1']),
        targeting({ ...mockDiscount, id: 'variantSale' }, []),
      ]);

      const result = await service.findCandidateDiscounts(
        [variant('variant1', 'variantSale'), variant('variant2')],
        now,
      );

      expect(result.map((d) => [d.id, d.variantIds, d.productIds, d.categoryIds])).toEqual([
        ['discount1', [], [], ['category1']],
        ['variantSale', ['variant1'], [], []],
      ]);
    });

    it('does not query for an empty list', async () => {
      const result = await service.findCandidateDiscounts([], now);

      expect(result).toEqual([]);
      expect(discountRepository.findActiveDiscountsFor).not.toHaveBeenCalled();
    });
  });

  describe('validateDiscountInput (private)', () => {
    it('should throw BadRequestException for negative discount value', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: new Decimal('-10'),
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow('Discount value must be non-negative');
    });

    it('should throw BadRequestException for percentage > 100', async () => {
      const input = {
        name: 'Test',
        type: DiscountType.PERCENTAGE,
        value: new Decimal('150'),
        startDate: new Date(),
        endDate: new Date(),
      } as CreateDiscountInput;

      await expect(service['validateDiscountInput'](input)).rejects.toThrow(
        'Percentage discount value cannot exceed 100',
      );
    });
  });

  describe('addToDiscount', () => {
    it('should add products to a discount successfully', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(updatedDiscount);

      const result = await service.addToDiscount(
        {
          discountId: 'discount1',
          products: ['product1'],
          variants: [],
          categories: [],
        },
        'admin1',
      );

      expect(result).toEqual(updatedDiscount);
      expect(mockDiscountRepository.addItemsToDiscount).toHaveBeenCalledWith(
        'discount1',
        expect.objectContaining({ products: { connect: [{ id: 'product1' }] } }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:discount1');
    });

    it('should throw NotFoundException if discount not found', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(service.addToDiscount({ discountId: 'nonexistent', products: ['p1'] }, 'admin1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException for invalid product IDs', async () => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue(['invalid-id']);

      await expect(
        service.addToDiscount({ discountId: 'discount1', products: ['invalid-id'] }, 'admin1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not call addItemsToDiscount with empty products/variants/categories', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(updatedDiscount);

      await service.addToDiscount({ discountId: 'discount1' }, 'admin1');

      expect(mockDiscountRepository.addItemsToDiscount).toHaveBeenCalledWith(
        'discount1',
        {
          products: undefined,
          variants: undefined,
          categories: undefined,
        },
        AUDIT_TX,
      );
    });
  });

  describe('removeFromDiscount', () => {
    it('should remove products from a discount successfully', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(updatedDiscount);

      const result = await service.removeFromDiscount(
        {
          discountId: 'discount1',
          products: ['product1'],
          variants: [],
          categories: [],
        },
        'admin1',
      );

      expect(result).toEqual(updatedDiscount);
      expect(mockDiscountRepository.removeItemsFromDiscount).toHaveBeenCalledWith(
        'discount1',
        expect.objectContaining({ products: { disconnect: [{ id: 'product1' }] } }),
        AUDIT_TX,
      );
      expect(mockCacheManager.del).toHaveBeenCalledWith('discount:all');
    });

    it('should throw NotFoundException if discount not found', async () => {
      mockDiscountRepository.findById.mockResolvedValue(null);

      await expect(
        service.removeFromDiscount({ discountId: 'nonexistent', products: ['p1'] }, 'admin1'),
      ).rejects.toThrow(NotFoundException);
    });

    it('should handle empty arrays by passing undefined to repository', async () => {
      const updatedDiscount = { ...mockDiscount };
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(updatedDiscount);

      await service.removeFromDiscount({ discountId: 'discount1' }, 'admin1');

      expect(mockDiscountRepository.removeItemsFromDiscount).toHaveBeenCalledWith(
        'discount1',
        {
          products: undefined,
          variants: undefined,
          categories: undefined,
        },
        AUDIT_TX,
      );
    });
  });

  describe('audit trail', () => {
    beforeEach(() => {
      mockDiscountRepository.findById.mockResolvedValue(mockDiscount);
      mockDiscountRepository.getInvalidIds.mockResolvedValue([]);
      mockDiscountRepository.create.mockResolvedValue(mockDiscount);
      mockDiscountRepository.update.mockImplementation(async (_id, data) => ({
        ...mockDiscount,
        ...withoutUndefined(data),
      }));
      mockDiscountRepository.delete.mockResolvedValue(mockDiscount);
      mockDiscountRepository.addItemsToDiscount.mockResolvedValue(mockDiscount);
      mockDiscountRepository.removeItemsFromDiscount.mockResolvedValue(mockDiscount);
    });

    it.each<[string, () => Promise<unknown>, object]>([
      [
        'createDiscount',
        () =>
          service.createDiscount(
            {
              name: mockDiscount.name,
              type: DiscountType.PERCENTAGE,
              value: new Decimal('20'),
              startDate: new Date('2025-06-01'),
              endDate: new Date('2025-06-30'),
              isActive: true,
              products: ['product1'],
              variants: [],
              categories: [],
            },
            'admin1',
          ),
        {
          action: 'CREATE',
          details: {
            after: expect.objectContaining({ name: mockDiscount.name }),
            products: ['product1'],
            variants: [],
            categories: [],
          },
        },
      ],
      [
        'updateDiscount',
        () => service.updateDiscount('discount1', { id: 'discount1', isActive: !mockDiscount.isActive }, 'admin1'),
        {
          action: 'UPDATE',
          details: { changes: { isActive: { from: mockDiscount.isActive, to: !mockDiscount.isActive } } },
        },
      ],
      [
        'addToDiscount',
        () => service.addToDiscount({ discountId: 'discount1', products: ['product1'] }, 'admin1'),
        { action: 'UPDATE', details: { add: { products: ['product1'] } } },
      ],
      [
        'removeFromDiscount',
        () => service.removeFromDiscount({ discountId: 'discount1', categories: ['category1'] }, 'admin1'),
        { action: 'UPDATE', details: { remove: { categories: ['category1'] } } },
      ],
      [
        'deleteDiscount',
        () => service.deleteDiscount('discount1', 'admin1'),
        { action: 'DELETE', details: { before: expect.objectContaining({ name: mockDiscount.name }) } },
      ],
    ])('%s writes an audit entry with the acting admin in the same transaction', async (_name, act, expected) => {
      await act();

      expect(mockAuditService.log).toHaveBeenCalledTimes(1);
      expect(mockAuditService.log).toHaveBeenCalledWith(
        { entity: 'Discount', entityId: mockDiscount.id, userId: 'admin1', ...expected },
        AUDIT_TX,
      );
    });
  });
});
