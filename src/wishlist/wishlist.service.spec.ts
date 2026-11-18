import { Test, TestingModule } from '@nestjs/testing';
import { WishlistService } from './wishlist.service';
import { WishlistRepository } from './wishlist.repository';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WishList as Wishlist } from '../generated/prisma/client';

const mockWishlistRepository = {
  findByUser: jest.fn(),
  create: jest.fn(),
  findProductById: jest.fn(),
  connectProduct: jest.fn(),
  disconnectProduct: jest.fn(),
  clearProducts: jest.fn(),
};

describe('WishlistService', () => {
  let service: WishlistService;
  let wishlistRepository: jest.Mocked<WishlistRepository>;

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
  const mockProduct = { id: mockProductId };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WishlistService, { provide: WishlistRepository, useValue: mockWishlistRepository }],
    }).compile();

    service = module.get<WishlistService>(WishlistService);
    wishlistRepository = module.get<WishlistRepository>(WishlistRepository) as jest.Mocked<WishlistRepository>;
    jest.resetAllMocks();
  });

  describe('getOrCreateWishlist', () => {
    it('should return existing wishlist if it exists', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlist);

      const result = await service.getOrCreateWishlist(mockUserId);

      expect(wishlistRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(wishlistRepository.create).not.toHaveBeenCalled();
      expect(result).toEqual(mockWishlist);
    });

    it('should create and return a new wishlist if none exists', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(null);
      mockWishlistRepository.create.mockResolvedValue(mockWishlist);

      const result = await service.getOrCreateWishlist(mockUserId);

      expect(wishlistRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(wishlistRepository.create).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual(mockWishlist);
    });
  });

  describe('addToWishlist', () => {
    it('should add a product to the wishlist successfully', async () => {
      mockWishlistRepository.findProductById.mockResolvedValue(mockProduct);
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlist);
      mockWishlistRepository.connectProduct.mockResolvedValue(mockWishlistWithProduct);

      const result = await service.addToWishlist(mockUserId, mockProductId);

      expect(wishlistRepository.findProductById).toHaveBeenCalledWith(mockProductId);
      expect(wishlistRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(wishlistRepository.connectProduct).toHaveBeenCalledWith(mockWishlist.id, mockProductId);
      expect(result).toEqual(mockWishlistWithProduct);
    });

    it("should throw NotFoundException if product doesn't exist", async () => {
      mockWishlistRepository.findProductById.mockResolvedValue(null);

      await expect(service.addToWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found`),
      );
      expect(wishlistRepository.findByUser).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if product is already in wishlist', async () => {
      mockWishlistRepository.findProductById.mockResolvedValue(mockProduct);
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlistWithProduct);

      await expect(service.addToWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new BadRequestException(`Product "${mockProductId}" is already in your wishlist`),
      );
      expect(wishlistRepository.connectProduct).not.toHaveBeenCalled();
    });
  });

  describe('removeFromWishlist', () => {
    it('should remove a product from the wishlist successfully', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlistWithProduct);
      mockWishlistRepository.disconnectProduct.mockResolvedValue(mockWishlist);

      const result = await service.removeFromWishlist(mockUserId, mockProductId);

      expect(wishlistRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(wishlistRepository.disconnectProduct).toHaveBeenCalledWith(mockWishlist.id, mockProductId);
      expect(result).toEqual(mockWishlist);
    });

    it('should throw NotFoundException if product is not in wishlist', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlist);

      await expect(service.removeFromWishlist(mockUserId, mockProductId)).rejects.toThrow(
        new NotFoundException(`Product "${mockProductId}" not found in your wishlist`),
      );
      expect(wishlistRepository.disconnectProduct).not.toHaveBeenCalled();
    });
  });

  describe('clearWishlist', () => {
    it('should clear all products from the wishlist', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlistWithProduct);
      mockWishlistRepository.clearProducts.mockResolvedValue(mockWishlist);

      const result = await service.clearWishlist(mockUserId);

      expect(wishlistRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(wishlistRepository.clearProducts).toHaveBeenCalledWith(mockWishlist.id);
      expect(result).toEqual(mockWishlist);
    });

    it('should return empty wishlist if already empty', async () => {
      mockWishlistRepository.findByUser.mockResolvedValue(mockWishlist);
      mockWishlistRepository.clearProducts.mockResolvedValue(mockWishlist);

      const result = await service.clearWishlist(mockUserId);

      expect(wishlistRepository.clearProducts).toHaveBeenCalled();
      expect(result).toEqual(mockWishlist);
    });
  });

  describe('isProductInWishlist (private)', () => {
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
