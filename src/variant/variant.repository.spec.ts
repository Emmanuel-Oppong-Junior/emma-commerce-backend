import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { VariantRepository } from './variant.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Variant } from '../generated/prisma/client';

const mockVariant = {
  id: 'var1',
  productId: 'prod1',
  size: 'L',
  color: 'Blue',
  price: new Prisma.Decimal(29.99),
  quantity: 50,
  discountId: null,
  lowStockThreshold: 5,
  product: { id: 'prod1', name: 'T-Shirt' },
} as unknown as Variant & { product: { id: string; name: string } };

const mockPrismaVariant = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrismaProduct = { findUnique: jest.fn() };

const mockPrisma = { variant: mockPrismaVariant, product: mockPrismaProduct };

describe('VariantRepository', () => {
  let repository: VariantRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [VariantRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<VariantRepository>(VariantRepository);
    jest.clearAllMocks();
  });

  describe('findProductById', () => {
    it('should find a product by ID', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue({ id: 'prod1' });

      const result = await repository.findProductById('prod1');

      expect(result).toEqual({ id: 'prod1' });
    });

    it('should return null if not found', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(null);

      expect(await repository.findProductById('nonexistent')).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a variant with product include', async () => {
      mockPrismaVariant.create.mockResolvedValue(mockVariant);

      const result = await repository.create({ productId: 'prod1', name: 'Large', quantity: 50 } as any);

      expect(result).toEqual(mockVariant);
      expect(mockPrismaVariant.create).toHaveBeenCalledWith(
        expect.objectContaining({ include: { product: { select: { id: true, name: true } } } }),
      );
    });
  });

  describe('findById', () => {
    it('should find a variant by ID', async () => {
      mockPrismaVariant.findUnique.mockResolvedValue(mockVariant);

      const result = await repository.findById('var1');

      expect(result).toEqual(mockVariant);
    });

    it('should return null if not found', async () => {
      mockPrismaVariant.findUnique.mockResolvedValue(null);

      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findByProduct', () => {
    it('should return all variants for a product', async () => {
      mockPrismaVariant.findMany.mockResolvedValue([mockVariant]);

      const result = await repository.findByProduct('prod1');

      expect(result).toEqual([mockVariant]);
      expect(mockPrismaVariant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { productId: 'prod1' } }),
      );
    });
  });

  describe('findAll', () => {
    it('should return all variants', async () => {
      mockPrismaVariant.findMany.mockResolvedValue([mockVariant]);

      const result = await repository.findAll();

      expect(result).toEqual([mockVariant]);
    });
  });

  describe('update', () => {
    it('should update a variant', async () => {
      const updated = { ...mockVariant, size: 'XL' };
      mockPrismaVariant.update.mockResolvedValue(updated);

      const result = await repository.update('var1', { size: 'XL' } as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaVariant.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {} as any)).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaVariant.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('var1', {} as any)).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a variant', async () => {
      mockPrismaVariant.delete.mockResolvedValue(mockVariant);

      const result = await repository.delete('var1');

      expect(result).toEqual(mockVariant);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaVariant.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaVariant.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('var1')).rejects.toThrow('DB error');
    });
  });
});
