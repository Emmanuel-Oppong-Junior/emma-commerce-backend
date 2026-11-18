import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { TagRepository } from './tag.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, Tag } from '../generated/prisma/client';

const mockTag: Tag = {
  id: 'tag1',
  name: 'Sale',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockPrismaTag = {
  create: jest.fn(),
  findUnique: jest.fn(),
  findMany: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

const mockPrisma = { tag: mockPrismaTag };

describe('TagRepository', () => {
  let repository: TagRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [TagRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<TagRepository>(TagRepository);
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('should create a tag', async () => {
      mockPrismaTag.create.mockResolvedValue(mockTag);

      const result = await repository.create('Sale');

      expect(result).toEqual(mockTag);
      expect(mockPrismaTag.create).toHaveBeenCalledWith({ data: { name: 'Sale' } });
    });

    it('should throw ConflictException on P2002', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '5.0',
      });
      mockPrismaTag.create.mockRejectedValue(prismaError);

      await expect(repository.create('DupTag')).rejects.toThrow(ConflictException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTag.create.mockRejectedValue(new Error('DB error'));

      await expect(repository.create('X')).rejects.toThrow('DB error');
    });
  });

  describe('findById', () => {
    it('should find a tag by ID', async () => {
      mockPrismaTag.findUnique.mockResolvedValue(mockTag);

      const result = await repository.findById('tag1');

      expect(result).toEqual(mockTag);
    });

    it('should return null if not found', async () => {
      mockPrismaTag.findUnique.mockResolvedValue(null);

      expect(await repository.findById('nonexistent')).toBeNull();
    });
  });

  describe('findByName', () => {
    it('should find a tag by name', async () => {
      mockPrismaTag.findUnique.mockResolvedValue(mockTag);

      const result = await repository.findByName('Sale');

      expect(result).toEqual(mockTag);
      expect(mockPrismaTag.findUnique).toHaveBeenCalledWith({ where: { name: 'Sale' } });
    });
  });

  describe('findAll', () => {
    it('should return all tags ordered by name', async () => {
      mockPrismaTag.findMany.mockResolvedValue([mockTag]);

      const result = await repository.findAll();

      expect(result).toEqual([mockTag]);
      expect(mockPrismaTag.findMany).toHaveBeenCalledWith({ orderBy: { name: 'asc' } });
    });
  });

  describe('update', () => {
    it('should update a tag name', async () => {
      const updated = { ...mockTag, name: 'NewSale' };
      mockPrismaTag.update.mockResolvedValue(updated);

      const result = await repository.update('tag1', 'NewSale');

      expect(result).toEqual(updated);
      expect(mockPrismaTag.update).toHaveBeenCalledWith({ where: { id: 'tag1' }, data: { name: 'NewSale' } });
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTag.update.mockRejectedValue(prismaError);

      await expect(repository.update('nonexistent', 'X')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaTag.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.update('tag1', 'X')).rejects.toThrow('DB error');
    });
  });

  describe('delete', () => {
    it('should delete a tag', async () => {
      mockPrismaTag.delete.mockResolvedValue(mockTag);

      const result = await repository.delete('tag1');

      expect(result).toEqual(mockTag);
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaTag.delete.mockRejectedValue(prismaError);

      await expect(repository.delete('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors on delete', async () => {
      mockPrismaTag.delete.mockRejectedValue(new Error('DB error'));

      await expect(repository.delete('tag1')).rejects.toThrow('DB error');
    });
  });

  describe('connectProducts', () => {
    it('should connect products to a tag', async () => {
      const updatedTag = { ...mockTag };
      mockPrismaTag.update.mockResolvedValue(updatedTag);

      const result = await repository.connectProducts('tag1', ['prod1', 'prod2']);

      expect(mockPrismaTag.update).toHaveBeenCalledWith({
        where: { id: 'tag1' },
        data: { products: { connect: [{ id: 'prod1' }, { id: 'prod2' }] } },
      });
      expect(result).toEqual(updatedTag);
    });
  });

  describe('disconnectProducts', () => {
    it('should disconnect products from a tag', async () => {
      const updatedTag = { ...mockTag };
      mockPrismaTag.update.mockResolvedValue(updatedTag);

      const result = await repository.disconnectProducts('tag1', ['prod1']);

      expect(mockPrismaTag.update).toHaveBeenCalledWith({
        where: { id: 'tag1' },
        data: { products: { disconnect: [{ id: 'prod1' }] } },
      });
      expect(result).toEqual(updatedTag);
    });
  });
});
