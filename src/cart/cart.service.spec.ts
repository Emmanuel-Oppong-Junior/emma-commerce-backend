import { Test, TestingModule } from '@nestjs/testing';
import { CartService } from './cart.service';
import { CartRepository } from './cart.repository';
import { AddToCartInput } from './dto/add-to-cart.input';
import { UpdateCartItemInput } from './dto/update-cart.input';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Cart, CartItem, Prisma } from '../generated/prisma/client';

const mockCartRepository = {
  findByUser: jest.fn(),
  findOrCreate: jest.fn(),
  findVariant: jest.fn(),
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
    isActive: true,
    status: 'PUBLISHED',
    categoryId: 'cat1',
    createdAt: fixedDate,
    updatedAt: fixedDate,
    images: [],
  };
  const mockVariant = {
    id: 'var1',
    productId: 'prod1',
    sku: 'TSHIRT-M',
    price: new Prisma.Decimal('19.99'),
    stockLevels: [{ onHand: 100, reserved: 0, locationId: 'loc_main' }],
    isActive: true,
    product: mockProduct,
  };
  const mockCartItem: CartItem = {
    id: 'item1',
    cartId: 'cart1',
    productId: 'prod1',
    variantId: 'var1',
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
    const addInput: AddToCartInput = { variantId: 'var1', quantity: 2 };

    it('should add a new variant to the cart successfully, priced from the variant', async () => {
      mockCartRepository.findVariant.mockResolvedValue(mockVariant);
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue(null);
      mockCartRepository.upsertCartItem.mockResolvedValue(undefined);
      mockCartRepository.findByUser.mockResolvedValue(mockCart);

      const result = await service.addToCart(mockUserId, addInput);

      expect(cartRepository.findVariant).toHaveBeenCalledWith('var1');
      expect(cartRepository.findOrCreate).toHaveBeenCalledWith(mockUserId);
      expect(cartRepository.findCartItem).toHaveBeenCalledWith('cart1', 'var1');
      expect(cartRepository.upsertCartItem).toHaveBeenCalledWith(undefined, 'cart1', mockVariant, mockVariant.price, 2);
      expect(result).toEqual(mockCart);
    });

    it('merges the quantity into the existing line for the same variant', async () => {
      mockCartRepository.findVariant.mockResolvedValue(mockVariant);
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue({ id: 'item1', quantity: 1 });
      mockCartRepository.upsertCartItem.mockResolvedValue(undefined);
      mockCartRepository.findByUser.mockResolvedValue(mockCart);

      await service.addToCart(mockUserId, addInput);

      expect(cartRepository.upsertCartItem).toHaveBeenCalledWith('item1', 'cart1', mockVariant, mockVariant.price, 3);
    });

    it('should throw NotFoundException if variant does not exist', async () => {
      mockCartRepository.findVariant.mockResolvedValue(null);

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new NotFoundException(`Variant "var1" not found`),
      );
    });

    it("checks stock against the variant's available stock", async () => {
      mockCartRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        stockLevels: [{ onHand: 4, reserved: 3, locationId: 'loc_main' }],
      });
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue(null);

      await expect(service.addToCart(mockUserId, { variantId: 'var1', quantity: 5 })).rejects.toThrow(
        new BadRequestException('Cannot add 5 of "T-Shirt" (TSHIRT-M) to cart; only 1 in stock'),
      );
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });

    it('counts the quantity already in the cart against the variant stock', async () => {
      mockCartRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        stockLevels: [{ onHand: 3, reserved: 0, locationId: 'loc_main' }],
      });
      mockCartRepository.findOrCreate.mockResolvedValue({ id: 'cart1', userId: mockUserId });
      mockCartRepository.findCartItem.mockResolvedValue({ id: 'item1', quantity: 2 });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(BadRequestException);
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException if product is inactive', async () => {
      mockCartRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        product: { ...mockProduct, isActive: false },
      });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(BadRequestException);
    });

    it('refuses a variant of an unpublished product, without touching the cart', async () => {
      mockCartRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        product: { ...mockProduct, status: 'DRAFT' },
      });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new BadRequestException('"T-Shirt" (TSHIRT-M) is not on sale'),
      );
      expect(cartRepository.findOrCreate).not.toHaveBeenCalled();
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });

    it('refuses an archived variant', async () => {
      mockCartRepository.findVariant.mockResolvedValue({ ...mockVariant, isActive: false });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new BadRequestException('"T-Shirt" (TSHIRT-M) is no longer sold'),
      );
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });

    it('refuses a variant with no price', async () => {
      mockCartRepository.findVariant.mockResolvedValue({ ...mockVariant, price: null });

      await expect(service.addToCart(mockUserId, addInput)).rejects.toThrow(
        new BadRequestException('"T-Shirt" (TSHIRT-M) has no price and cannot be sold'),
      );
      expect(cartRepository.upsertCartItem).not.toHaveBeenCalled();
    });
  });

  describe('updateCartItem', () => {
    const updateInput: UpdateCartItemInput = { cartItemId: 'item1', quantity: 3 };

    it('should update cart item quantity successfully', async () => {
      mockCartRepository.findByUser.mockResolvedValueOnce(mockCart).mockResolvedValueOnce(mockCart);
      mockCartRepository.findVariant.mockResolvedValue(mockVariant);
      mockCartRepository.updateCartItem.mockResolvedValue({ ...mockCartItem, quantity: 3 });

      const result = await service.updateCartItem(mockUserId, updateInput);

      expect(cartRepository.findVariant).toHaveBeenCalledWith('var1');
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
      mockCartRepository.findVariant.mockResolvedValue({
        ...mockVariant,
        stockLevels: [{ onHand: 1, reserved: 0, locationId: 'loc_main' }],
      });

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
