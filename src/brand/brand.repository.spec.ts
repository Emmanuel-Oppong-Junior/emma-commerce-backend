import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { BrandRepository } from './brand.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Brand, Prisma } from '@prisma/client';

const mockBrand: Brand = {
  id: 'brand1',
  name: 'Nike',
  description: null,
  logo: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaBrand = {
  create: jest.fn(),
  update: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  delete: jest.fn(),
};

const mockPrisma = { brand: mockPrismaBrand };

describe('BrandRepository', () => {
  let repository: BrandRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [BrandRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<BrandRepository>(BrandRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a brand', async () => {
      mockPrismaBrand.create.mockResolvedValue(mockBrand);

      const result = await repository.create({ name: 'Nike' } as any);

      expect(result).toEqual(mockBrand);
    });

    it('should throw ConflictException on P2002', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaBrand.create.mockRejectedValue(prismaError);

      await expect(repository.create({ name: 'Dup' } as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaBrand.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({ name: 'X' } as any)).rejects.toThrow('DB error');
    });
  });

  describe('update', () => {
    it('should update a brand', async () => {
      const updated = { ...mockBrand, name: 'Adidas' };
      mockPrismaBrand.update.mockResolvedValue(updated);

      const result = await repository.update('brand1', { name: 'Adidas' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaBrand.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { name: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaBrand.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('brand1', { name: 'X' })).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a brand by ID', async () => {
      mockPrismaBrand.findUnique.mockResolvedValue(mockBrand);

      const result = await repository.findById('brand1');

      expect(result).toEqual(mockBrand);
    });

    it('should return null if not found', async () => {
      mockPrismaBrand.findUnique.mockResolvedValue(null);

      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findMany', () => {
    it('should return brands with query options', async () => {
      mockPrismaBrand.findMany.mockResolvedValue([mockBrand]);

      const result = await repository.findMany({ orderBy: { createdAt: 'desc' } });

      expect(result).toEqual([mockBrand]);
    });

    it('should return all brands with empty query options', async () => {
      mockPrismaBrand.findMany.mockResolvedValue([mockBrand]);

      const result = await repository.findMany();

      expect(result).toEqual([mockBrand]);
    });
  });

  describe('delete', () => {
    it('should delete a brand', async () => {
      mockPrismaBrand.delete.mockResolvedValue(mockBrand);

      const result = await repository.delete('brand1');

      expect(result).toEqual(mockBrand);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaBrand.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaBrand.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('brand1')).rejects.toThrow('DB error');
    });
  });
});
