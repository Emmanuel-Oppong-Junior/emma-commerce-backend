import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TaxRepository } from './tax.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Tax } from '@prisma/client';

const mockTax = {
  id: 'tax1',
  name: 'VAT',
  rate: new Prisma.Decimal('0.1500'),
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
} as unknown as Tax;

const mockPrismaTax = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrisma = { tax: mockPrismaTax };

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
    it('should create a tax', async () => {
      mockPrismaTax.create.mockResolvedValue(mockTax);

      const result = await repository.create({ name: 'VAT', rate: 0.15 } as any);

      expect(result).toEqual(mockTax);
    });

    it('should throw ConflictException on P2002 (duplicate name)', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaTax.create.mockRejectedValue(prismaError);

      await expect(repository.create({ name: 'VAT', rate: 0.15 } as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTax.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ name: 'VAT', rate: 0.15 } as any)).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a tax by ID', async () => {
      mockPrismaTax.findUnique.mockResolvedValue(mockTax);

      const result = await repository.findById('tax1');

      expect(result).toEqual(mockTax);
    });

    it('should return null if not found', async () => {
      mockPrismaTax.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findAll', () => {
    it('should return all taxes ordered by name', async () => {
      mockPrismaTax.findMany.mockResolvedValue([mockTax]);

      const result = await repository.findAll();

      expect(result).toEqual([mockTax]);
      expect(mockPrismaTax.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
    });
  });

  describe('getTotalActiveRate', () => {
    it('should return sum of all active tax rates', async () => {
      mockPrismaTax.findMany.mockResolvedValue([
        { ...mockTax, rate: new Prisma.Decimal('0.15') },
        { ...mockTax, id: 'tax2', name: 'NHIS', rate: new Prisma.Decimal('0.025') },
      ]);

      const result = await repository.getTotalActiveRate();

      expect(result).toEqual(new Prisma.Decimal('0.175'));
      expect(mockPrismaTax.findMany).toHaveBeenCalledWith({ where: { isActive: true } });
    });

    it('should return 0 when no active taxes', async () => {
      mockPrismaTax.findMany.mockResolvedValue([]);

      const result = await repository.getTotalActiveRate();

      expect(result).toEqual(new Prisma.Decimal(0));
    });
  });

  describe('repriceTaxableProducts', () => {
    it('binds the multiplier as a Decimal cast to numeric, never a float', async () => {
      const executeRaw = jest.fn().mockResolvedValue(3);

      await repository.repriceTaxableProducts(new Prisma.Decimal('0.15'), {
        $executeRaw: executeRaw,
      } as unknown as Prisma.TransactionClient);

      expect(executeRaw).toHaveBeenCalledTimes(1);
      const [sql, multiplier] = executeRaw.mock.calls[0] as [TemplateStringsArray, unknown];
      expect(multiplier).toEqual(new Prisma.Decimal('1.15'));
      expect(multiplier).toBeInstanceOf(Prisma.Decimal);
      expect(sql.join('?')).toContain('?::numeric, 2)');
    });
  });

  describe('update', () => {
    it('should update a tax', async () => {
      const updated = { ...mockTax, rate: new Prisma.Decimal('0.2') };
      mockPrismaTax.update.mockResolvedValue(updated);

      const result = await repository.update('tax1', { rate: 0.2 } as any);

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTax.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', {})).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTax.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('tax1', {})).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a tax', async () => {
      mockPrismaTax.delete.mockResolvedValue(mockTax);

      const result = await repository.delete('tax1');

      expect(result).toEqual(mockTax);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTax.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTax.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('tax1')).rejects.toThrow('DB error');
    });
  });
});
