import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AddressesRepository } from './addresses.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Address, Prisma } from '../generated/prisma/client';

const mockAddress: Address = {
  id: 'addr1',
  userId: 'user1',
  street: '1 Main St',
  city: 'Accra',
  state: 'GA',
  zipCode: '00233',
  country: 'GH',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaAddress = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
  count: jest.fn(),
};

const mockPrisma = { address: mockPrismaAddress };

describe('AddressesRepository', () => {
  let repository: AddressesRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AddressesRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<AddressesRepository>(AddressesRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create an address', async () => {
      mockPrismaAddress.create.mockResolvedValue(mockAddress);

      const result = await repository.create({
        userId: 'user1',
        street: '1 Main St',
        city: 'Accra',
        state: 'GA',
        zipCode: '00233',
        country: 'GH',
      } as any);

      expect(result).toEqual(mockAddress);
    });

    it('should throw ConflictException on P2002', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaAddress.create.mockRejectedValue(prismaError);

      await expect(repository.create({} as any)).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaAddress.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create({} as any)).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should return an address by ID', async () => {
      mockPrismaAddress.findUnique.mockResolvedValue(mockAddress);

      const result = await repository.findById('addr1');

      expect(result).toEqual(mockAddress);
    });

    it('should return null if not found', async () => {
      mockPrismaAddress.findUnique.mockResolvedValue(null);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('findByUser', () => {
    it('should return all addresses for a user', async () => {
      mockPrismaAddress.findMany.mockResolvedValue([mockAddress]);

      const result = await repository.findByUser('user1');

      expect(result).toEqual([mockAddress]);
      expect(mockPrismaAddress.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user1' } }));
    });
  });

  describe('findAll', () => {
    it('should return all addresses', async () => {
      mockPrismaAddress.findMany.mockResolvedValue([mockAddress]);

      const result = await repository.findAll();

      expect(result).toEqual([mockAddress]);
    });
  });

  describe('update', () => {
    it('should update an address', async () => {
      const updated = { ...mockAddress, city: 'Kumasi' };
      mockPrismaAddress.update.mockResolvedValue(updated);

      const result = await repository.update('addr1', { city: 'Kumasi' });

      expect(result).toEqual(updated);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaAddress.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', { city: 'X' })).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaAddress.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('addr1', { city: 'X' })).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete an address', async () => {
      mockPrismaAddress.delete.mockResolvedValue(mockAddress);

      const result = await repository.delete('addr1');

      expect(result).toEqual(mockAddress);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaAddress.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaAddress.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('addr1')).rejects.toThrow('DB error');
    });
  });

  describe('countByUser', () => {
    it('should count addresses for a user', async () => {
      mockPrismaAddress.count.mockResolvedValue(3);

      const result = await repository.countByUser('user1');

      expect(result).toBe(3);
      expect(mockPrismaAddress.count).toHaveBeenCalledWith({ where: { userId: 'user1' } });
    });
  });
});
