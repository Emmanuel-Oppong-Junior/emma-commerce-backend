import { Test, TestingModule } from '@nestjs/testing';
import { WishlistService } from './wishlist.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WishList as Wishlist } from '@prisma/client';

describe('WishlistService', () => {
  let service: WishlistService;
  let prismaService: PrismaService;

  const mockPrismaService = {
    wishList: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
    },
  };

  const mockUserId = 'user1';
  const mockProductId = 'prod1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockWishlist: Wishlist & { products: { id: string; name: string }[] } = {
    id: 'wish1',
    userId: mockUserId,
    createdAt: fixedDate,
    updatedAt: fixedDate,
    products: [],
  };
  const mockWishlistWithProduct = {
    ...mockWishlist,
    products: [{ id: mockProductId, name: 'T-Shirt' }],
  };
  const mockProduct = {
    id: mockProductId,
    name: 'T-Shirt',
    price: 19.99,
    quantity: 100,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WishlistService, { provide: PrismaService, useValue: mockPrismaService }],
    }).compile();

    service = module.get<WishlistService>(WishlistService);
    prismaService = module.get<PrismaService>(PrismaService);
    jest.resetAllMocks();
  });

  describe('getOrCreateWishlist', () => {
    it('should return existing wishlist if it exists', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlist);

      const result = await service.getOrCreateWishlist(mockUserId);

      expect(prismaService.wishList.findUnique).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        include: { products: true },
      });
      expect(prismaService.wishList.create).not.toHaveBeenCalled();
      expect(result).toEqual(mockWishlist);
    });

    it('should create and return a new wishlist if none exists', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(null);
      mockPrismaService.wishList.create.mockResolvedValue(mockWishlist);

      const result = await service.getOrCreateWishlist(mockUserId);

      expect(prismaService.wishList.findUnique).toHaveBeenCalledWith({
        where: { userId: mockUserId },
        include: { products: true },
      });
      expect(prismaService.wishList.create).toHaveBeenCalledWith({
        data: { userId: mockUserId },
        include: { products: true },
      });
      expect(result).toEqual(mockWishlist);
    });
  });

  describe('addToWishlist', () => {
    it('should add a product to the wishlist successfully', async () => {
      mockPrismaService.product.findUnique.mockResolvedValue(mockProduct);
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlist);
      mockPrismaService.wishList.update.mockResolvedValue(mockWishlistWithProduct);

      const result = await service.addToWishlist(mockUserId, mockProductId);

      expect(prismaService.product.findUnique).toHaveBeenCalledWith({
        where: { id: mockProductId },
      });
      expect(prismaService.wishList.findUnique).toHaveBeenCalled();
      expect(prismaService.wishList.update).toHaveBeenCalledWith({
        where: { id: mockWishlist.id },
        data: { products: { connect: { id: mockProductId } } },
        include: { products: true },
      });
      expect(result).toEqual(mockWishlistWithProduct);
    });

    it('should throw NotFoundException if product doesn’t exist', async () => {
      mockPrismaService.product.findUnique.mockResolvedValue(null);

      await expect(service.addToWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(prismaService.wishList.findUnique).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if product is already in wishlist', async () => {
      mockPrismaService.product.findUnique.mockResolvedValue(mockProduct);
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlistWithProduct);

      await expect(service.addToWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new BadRequestException(`Product "${mockProductId}" is already in your wishlist`),
      );
      expect(prismaService.wishList.update).not.toHaveBeenCalled();
    });
  });

  describe('removeFromWishlist', () => {
    it('should remove a product from the wishlist successfully', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlistWithProduct);
      mockPrismaService.wishList.update.mockResolvedValue(mockWishlist);

      const result = await service.removeFromWishlist(mockUserId, mockProductId);

      expect(prismaService.wishList.findUnique).toHaveBeenCalled();
      expect(prismaService.wishList.update).toHaveBeenCalledWith({
        where: { id: mockWishlist.id },
        data: { products: { disconnect: { id: mockProductId } } },
        include: { products: true },
      });
      expect(result).toEqual(mockWishlist);
    });

    it('should throw NotFoundException if product is not in wishlist', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlist);

      await expect(service.removeFromWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found in your wishlist`),
      );
      expect(prismaService.wishList.update).not.toHaveBeenCalled();
    });
  });

  describe('clearWishlist', () => {
    it('should clear all products from the wishlist', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlistWithProduct);
      mockPrismaService.wishList.update.mockResolvedValue(mockWishlist);

      const result = await service.clearWishlist(mockUserId);

      expect(prismaService.wishList.findUnique).toHaveBeenCalled();
      expect(prismaService.wishList.update).toHaveBeenCalledWith({
        where: { id: mockWishlist.id },
        data: { products: { set: [] } },
        include: { products: true },
      });
      expect(result).toEqual(mockWishlist);
    });

    it('should return empty wishlist if already empty', async () => {
      mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlist);
      mockPrismaService.wishList.update.mockResolvedValue(mockWishlist);

      const result = await service.clearWishlist(mockUserId);

      expect(prismaService.wishList.update).toHaveBeenCalled();
      expect(result).toEqual(mockWishlist);
    });
  });

  // Private Helper Methods
  describe('private methods', () => {
    describe('fetchWishlist', () => {
      it('should fetch wishlist by userId', async () => {
        mockPrismaService.wishList.findUnique.mockResolvedValue(mockWishlist);

        const result = await service['fetchWishlist'](mockUserId);

        expect(prismaService.wishList.findUnique).toHaveBeenCalledWith({
          where: { userId: mockUserId },
          include: { products: true },
        });
        expect(result).toEqual(mockWishlist);
      });
    });

    describe('isProductInWishlist', () => {
      it('should return true if product is in wishlist', () => {
        const result = service['isProductInWishlist'](mockWishlistWithProduct, mockProductId);
        expect(result).toBe(true);
      });

      it('should return false if product is not in wishlist', () => {
        const result = service['isProductInWishlist'](mockWishlist, mockProductId);
        expect(result).toBe(false);
      });
    });
  });
});
