import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { AddToCartInput } from './dto/add-to-cart.input';
import { UpdateCartItemInput } from './dto/update-cart.input';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Cart, CartItem } from '@prisma/client';

const mockCartRepository = {
  findByUser: jest.fn(),
  findOrCreate: jest.fn(),
  findProductById: jest.fn(),
  countVariants: jest.fn(),
  findCartItem: jest.fn(),
  upsertCartItem: jest.fn(),
  updateCartItem: jest.fn(),
  deleteCartItem: jest.fn(),
  deleteAllCartItems: jest.fn(),
};

describe('CartService', () => {
  let service: CartService;
  let cartRepository: jest.Mocked<CartRepository>;

  const mockUserId = 'user1';
  const fixedDate = new Date('2025-03-18T00:00:00.000Z');
  const mockProduct = {
    id: 'prod1',
    name: 'T-Shirt',
    price: 19.99,
    quantity: 100,
    isActive: true,
    categoryId: 'cat1',
    createdAt: fixedDate,
    updatedAt: fixedDate,
    images: [],
  };
  const mockCartItem: CartItem = {
    id: 'item1',
    cartId: 'cart1',
    productId: 'prod1',
    quantity: 2,
    createdAt: fixedDate,
    updatedAt: fixedDate,
  } as CartItem;
  const mockCart: Cart & { items: CartItem[] } = {
    id: 'cart1',
    userId: mockUserId,
    items: [{ ...mockCartItem, product: mockProduct }] as unknown as CartItem[],
    createdAt: fixedDate,
    updatedAt: fixedDate,
  };
  const emptyCart: Cart & { items: CartItem[] } = { ...mockCart, items: [] };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CartService, { provide: CartRepository, useValue: mockCartRepository }],
    }).compile();

    service = module.get<CartService>(CartService);
    cartRepository = module.get<CartRepository>(CartRepository) as jest.Mocked<CartRepository>;
    jest.resetAllMocks();
    mockCartRepository.countVariants.mockResolvedValue(0);
  });

  describe('getCart', () => {
    it("should retrieve the user's cart successfully", async () => {
      mockCartRepository.findByUser.mockResolvedValue(mockCart);

      const result = await service.getCart(mockUserId);

      expect(cartRepository.findByUser).toHaveBeenCalledWith(mockUserId);
      expect(result).toEqual(mockCart);
    });

    it('should return null if cart does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue(null);

      const result = await service.getCart(mockUserId);

      expect(result).toBeNull();
    });
  });

  describe('addToCart', () => {
    const addInput: AddToCartInput = { productId: 'prod1', quantity: 2 };

    it('should add a new product to the cart successfully', async () => {
      mockCartRepository.findProductById.mockResolvedValue(mockProduct);
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue(null);
      mockCartRepository.upsertCartItem.mockResolvedValue(undefined);
      mockCartRepository.findByUser.mockResolvedValue(mockCart);

      const result = await service.addToCart(mockUserId, addInput);

      expect(cartRepository.findProductById).toHaveBeenCalledWith('prod1');
      expect(cartRepository.findOrCreate).toHaveBeenCalledWith(mockUserId);
      expect(cartRepository.upsertCartItem).toHaveBeenCalled();
      expect(result).toEqual(mockCart);
    });

    it('should update quantity if product already exists in cart', async () => {
      mockCartRepository.findProductById.mockResolvedValue(mockProduct);
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue({ id: 'item1', quantity: 1 });
      mockCartRepository.upsertCartItem.mockResolvedValue(undefined);
      mockCartRepository.findByUser.mockResolvedValue(mockCart);

      await service.addToCart(mockUserId, addInput);

      expect(cartRepository.upsertCartItem).toHaveBeenCalledWith('item1', 'cart1', 'prod1', mockProduct.price, 3, 2);
    });

    it('refuses a product that has variants, without touching the cart', async () => {
      mockCartRepository.findProductById.mockResolvedValue(mockProduct);
      mockCartRepository.countVariants.mockResolvedValue(2);

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new BadRequestException('"T-Shirt" comes in variants and cannot be bought until variant checkout is available'),
      );
      expect(cartRepository.countVariants).toHaveBeenCalledWith('prod1');
      expect(cartRepository.findOrCreate).not.toHaveBeenCalled();
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });

    it('should throw NotFoundException if product does not exist', async () => {
      mockCartRepository.findProductById.mockResolvedValue(null);

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new NotFoundException(`Product "prod1" not found`),
      );
    });

    it('should throw BadRequestException if quantity exceeds stock', async () => {
      mockCartRepository.findProductById.mockResolvedValue({ ...mockProduct, quantity: 1 });

      await expect(service.addToCart(mockUserId, { productId: 'prod1', quantity: 5 })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if product is inactive', async () => {
      mockCartRepository.findProductById.mockResolvedValue({ ...mockProduct, isActive: false });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateCartItem', () => {
    const updateInput: UpdateCartItemInput = { cartItemId: 'item1', quantity: 3 };

    it('should update cart item quantity successfully', async () => {
      mockCartRepository.findByUser.mockResolvedValueOnce(mockCart).mockResolvedValueOnce(mockCart);
      mockCartRepository.findProductById.mockResolvedValue(mockProduct);
      mockCartRepository.updateCartItem.mockResolvedValue({ ...mockCartItem, quantity: 3 });

      const result = await service.updateCartItem(mockUserId, updateInput);

      expect(cartRepository.updateCartItem).toHaveBeenCalledWith('item1', { quantity: 3 });
      expect(result).toEqual(mockCart);
    });

    it('should remove cart item if quantity is 0', async () => {
      mockCartRepository.findByUser.mockResolvedValueOnce(mockCart).mockResolvedValueOnce(emptyCart);
      mockCartRepository.deleteCartItem.mockResolvedValue(undefined);

      const result = await service.updateCartItem(mockUserId, { cartItemId: 'item1', quantity: 0 });

      expect(cartRepository.deleteCartItem).toHaveBeenCalledWith('item1');
      expect(result).toEqual(emptyCart);
    });

    it('should throw NotFoundException if cart does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue(null);

      await expect(service.updateCartItem(mockUserId, updateInput)).rejects.toThrow(
        new NotFoundException(`Cart for user "${mockUserId}" not found`),
      );
    });

    it('should throw NotFoundException if cart item does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue({ ...mockCart, items: [] });

      await expect(service.updateCartItem(mockUserId, updateInput)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException if quantity exceeds stock', async () => {
      mockCartRepository.findByUser.mockResolvedValue(mockCart);
      mockCartRepository.findProductById.mockResolvedValue({ ...mockProduct, quantity: 1 });

      await expect(service.updateCartItem(mockUserId, { cartItemId: 'item1', quantity: 5 })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('removeFromCart', () => {
    it('should remove a cart item successfully', async () => {
      mockCartRepository.findByUser.mockResolvedValueOnce(mockCart).mockResolvedValueOnce(emptyCart);
      mockCartRepository.deleteCartItem.mockResolvedValue(undefined);

      const result = await service.removeFromCart(mockUserId, 'item1');

      expect(cartRepository.deleteCartItem).toHaveBeenCalledWith('item1');
      expect(result).toEqual(emptyCart);
    });

    it('should throw NotFoundException if cart does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue(null);

      await expect(service.removeFromCart(mockUserId, 'item1')).rejects.toThrow(
        new NotFoundException(`Cart for user "${mockUserId}" not found`),
      );
    });

    it('should throw NotFoundException if cart item does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue({ ...mockCart, items: [] });

      await expect(service.removeFromCart(mockUserId, 'item1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('clearCart', () => {
    it('should clear all items from the cart successfully', async () => {
      mockCartRepository.findByUser.mockResolvedValueOnce(mockCart).mockResolvedValueOnce(emptyCart);
      mockCartRepository.deleteAllCartItems.mockResolvedValue(undefined);

      const result = await service.clearCart(mockUserId);

      expect(cartRepository.deleteAllCartItems).toHaveBeenCalledWith('cart1');
      expect(result).toEqual(emptyCart);
    });

    it('should throw NotFoundException if cart does not exist', async () => {
      mockCartRepository.findByUser.mockResolvedValue(null);

      await expect(service.clearCart(mockUserId)).rejects.toThrow(
        new NotFoundException(`Cart for user "${mockUserId}" not found`),
      );
    });
  });
});
