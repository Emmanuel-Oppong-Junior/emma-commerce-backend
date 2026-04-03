import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TaxRepository } from './tax.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, TaxRate } from '@prisma/client';

const mockTaxRate = {
  id: 'tax1',
  country: 'US',
  region: 'CA',
  rate: new Prisma.Decimal(8.5),
  isActive: true,
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as TaxRate;

const mockPrismaTaxRate = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrisma = { taxRate: mockPrismaTaxRate };

describe('TaxRepository', () => {
  let repository: TaxRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TaxRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<TaxRepository>(TaxRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a tax rate', async () => {
      mockPrismaTaxRate.create.mockResolvedValue(mockTaxRate);

      const result = await repository.create({ country: 'US', region: 'CA', rate: 8.5 } as any);

      expect(result).toEqual(mockTaxRate);
    });

    it('should throw ConflictException on P2002 (duplicate)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaTaxRate.create.mockRejectedValue(prismaError);

      await expect(repository.create({ country: 'US', region: 'CA', rate: 8.5 } as any)).rejects.toThrow(
        ConflictException,
      );
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTaxRate.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ country: 'US', rate: 5 } as any)).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a tax rate by ID', async () => {
      mockPrismaTaxRate.findUnique.mockResolvedValue(mockTaxRate);

      const result = await repository.findById('tax1');

      expect(result).toEqual(mockTaxRate);
    });

    it('should return null if not found', async () => {
      mockPrismaTaxRate.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all tax rates ordered by country and region', async () => {
      mockPrismaTaxRate.findMany.mockResolvedValue([mockTaxRate]);

      const result = await repository.findAll();

      expect(result).toEqual([mockTaxRate]);
      expect(mockPrismaTaxRate.findMany).toHaveBeenCalledWith({
        orderBy: [{ country: 'asc' }, { region: 'asc' }],
      });
    });
  });

  describe('findByCountry', () => {
    it('should return exact match for country+region', async () => {
      mockPrismaTaxRate.findFirst.mockResolvedValueOnce(mockTaxRate);

      const result = await repository.findByCountry('US', 'CA');

      expect(result).toEqual(mockTaxRate);
      expect(mockPrismaTaxRate.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should fall back to country-only if no region match', async () => {
      const countryOnlyRate = { ...mockTaxRate, region: null };
      mockPrismaTaxRate.findFirst
        .mockResolvedValueOnce(null) // exact match fails
        .mockResolvedValueOnce(countryOnlyRate); // country-only match

      const result = await repository.findByCountry('US', 'NY');

      expect(result).toEqual(countryOnlyRate);
      expect(mockPrismaTaxRate.findFirst).toHaveBeenCalledTimes(2);
    });

    it('should return null if no match and no region specified', async () => {
      mockPrismaTaxRate.findFirst.mockResolvedValueOnce(null);

      const result = await repository.findByCountry('XX');

      expect(result).toBeNull();
    });

    it('should return country-only rate when no region argument provided', async () => {
      mockPrismaTaxRate.findFirst.mockResolvedValueOnce(mockTaxRate);

      const result = await repository.findByCountry('US');

      expect(result).toEqual(mockTaxRate);
    });
  });

  describe('update', () => {
    it('should update a tax rate', async () => {
      const updated = { ...mockTaxRate, rate: new Prisma.Decimal(9.0) };
      mockPrismaTaxRate.update.mockResolvedValue(updated);

      const result = await repository.update('tax1', { rate: 9.0 } as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTaxRate.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTaxRate.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('tax1', {})).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a tax rate', async () => {
      mockPrismaTaxRate.delete.mockResolvedValue(mockTaxRate);

      const result = await repository.delete('tax1');

      expect(result).toEqual(mockTaxRate);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTaxRate.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTaxRate.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('tax1')).rejects.toThrow('DB error');
    });
  });
});
