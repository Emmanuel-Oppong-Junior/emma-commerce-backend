import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { WishlistRepository } from './wishlist.repository';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, WishList } from '../generated/prisma/client';

const mockWishlist = {
  id: 'wishlist1',
  userId: 'user1',
  products: [{ id: 'prod1', name: 'T-Shirt' }],
} as unknown as WishList & { products: { id: string; name: string }[] };

const mockPrismaWishList = {
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};

const mockPrismaProduct = { findUnique: jest.fn() };

const mockPrisma = { wishList: mockPrismaWishList, product: mockPrismaProduct };

describe('WishlistRepository', () => {
  let repository: WishlistRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WishlistRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repository = module.get<WishlistRepository>(WishlistRepository);
    jest.clearAllMocks();
  });

  describe('findByUser', () => {
    it('should return wishlist for a user', async () => {
      mockPrismaWishList.findUnique.mockResolvedValue(mockWishlist);

      const result = await repository.findByUser('user1');

      expect(result).toEqual(mockWishlist);
      expect(mockPrismaWishList.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user1' }, include: { products: true } }),
      );
    });

    it('should return null if wishlist not found', async () => {
      mockPrismaWishList.findUnique.mockResolvedValue(null);

      const result = await repository.findByUser('user1');

      expect(result).toBeNull();
    });
  });

  describe('create', () => {
    it('should create a wishlist for a user', async () => {
      const newWishlist = { ...mockWishlist, products: [] };
      mockPrismaWishList.create.mockResolvedValue(newWishlist);

      const result = await repository.create('user1');

      expect(result).toEqual(newWishlist);
      expect(mockPrismaWishList.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: { userId: 'user1' }, include: { products: true } }),
      );
    });
  });

  describe('findProductById', () => {
    it('should find a product by ID', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue({ id: 'prod1' });

      const result = await repository.findProductById('prod1');

      expect(result).toEqual({ id: 'prod1' });
    });

    it('should return null if product not found', async () => {
      mockPrismaProduct.findUnique.mockResolvedValue(null);

      const result = await repository.findProductById('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('connectProduct', () => {
    it('should connect a product to the wishlist', async () => {
      const updated = { ...mockWishlist };
      mockPrismaWishList.update.mockResolvedValue(updated);

      const result = await repository.connectProduct('wishlist1', 'prod1');

      expect(result).toEqual(updated);
      expect(mockPrismaWishList.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'wishlist1' },
          data: { products: { connect: { id: 'prod1' } } },
        }),
      );
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaWishList.update.mockRejectedValue(prismaError);

      await expect(repository.connectProduct('nonexistent', 'prod1')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaWishList.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.connectProduct('wishlist1', 'prod1')).rejects.toThrow('DB error');
    });
  });

  describe('disconnectProduct', () => {
    it('should disconnect a product from the wishlist', async () => {
      const updated = { ...mockWishlist, products: [] };
      mockPrismaWishList.update.mockResolvedValue(updated);

      const result = await repository.disconnectProduct('wishlist1', 'prod1');

      expect(result).toEqual(updated);
      expect(mockPrismaWishList.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { products: { disconnect: { id: 'prod1' } } },
        }),
      );
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaWishList.update.mockRejectedValue(prismaError);

      await expect(repository.disconnectProduct('nonexistent', 'prod1')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaWishList.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.disconnectProduct('wishlist1', 'prod1')).rejects.toThrow('DB error');
    });
  });

  describe('clearProducts', () => {
    it('should clear all products from the wishlist', async () => {
      const cleared = { ...mockWishlist, products: [] };
      mockPrismaWishList.update.mockResolvedValue(cleared);

      const result = await repository.clearProducts('wishlist1');

      expect(result).toEqual(cleared);
      expect(mockPrismaWishList.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'wishlist1' },
          data: { products: { set: [] } },
        }),
      );
    });

    it('should throw NotFoundException on P2025', async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError('Not found', {
        code: 'P2025',
        clientVersion: '5.0',
      });
      mockPrismaWishList.update.mockRejectedValue(prismaError);

      await expect(repository.clearProducts('nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('should rethrow unknown errors', async () => {
      mockPrismaWishList.update.mockRejectedValue(new Error('DB error'));

      await expect(repository.clearProducts('wishlist1')).rejects.toThrow('DB error');
    });
  });
});
